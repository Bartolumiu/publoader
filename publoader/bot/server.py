"""Discord control bot.

Runs as its own process. Connects to Discord and exposes prefix + slash
commands that forward into the main publoader instance via IPC. The bot is
control-only — run/error notifications keep going through the existing
discord_webhook path configured by `WEBHOOK_URL`.
"""
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import List, Optional

try:
    import discord
    from discord import app_commands
    from discord.ext import commands
except ImportError:  # pragma: no cover - import guard
    sys.stderr.write(
        "discord.py is required for the bot. Install with `pip install discord.py`.\n"
    )
    raise

try:
    import docker as docker_sdk
    from docker.errors import APIError as DockerAPIError, DockerException, NotFound as DockerNotFound
    from docker.types import Mount as DockerMount
except ImportError:  # pragma: no cover - optional at import time
    docker_sdk = None
    DockerAPIError = DockerException = DockerNotFound = Exception
    DockerMount = None

from publoader.ipc import ipc_call, is_instance_running
from publoader.utils.config import config

logger = logging.getLogger("webhook")


def _scheduler_container_name() -> str:
    return (
        os.environ.get("PUBLOADER_SCHEDULER_CONTAINER")
        or config["Paths"].get("scheduler_container")
        or "publoader"
    )


def _docker_container():
    """Return the scheduler container handle, or a 1-line error string on failure.
    The bot keeps running either way — callers just surface the error to Discord.
    """
    if docker_sdk is None:
        return "docker SDK not installed in the bot container (pip install docker)."
    try:
        client = docker_sdk.from_env()
        return client.containers.get(_scheduler_container_name())
    except DockerNotFound:
        return f"No container named {_scheduler_container_name()!r} found."
    except (DockerException, OSError) as e:
        return f"Could not reach the docker daemon: {e}"


def _extension_sidecar_names() -> List[str]:
    """Sidecar container names whose CMD runs sync_extensions.py.
    Comma- or space-separated via env var or [Paths]extension_sidecars."""
    raw = (
        os.environ.get("PUBLOADER_EXTENSION_SIDECARS")
        or config["Paths"].get("extension_sidecars")
        or "publoader-extensions,publoader-extensions-private"
    )
    return [n.strip() for n in raw.replace(",", " ").split() if n.strip()]


def _refresh_sidecar(name: str, pull: bool = True, wait_seconds: int = 180) -> dict:
    """Pull the sidecar's image (optional), re-run the container, wait for exit.

    When the pulled image differs from the running container's image hash we
    recreate the container — `container.start()` alone would re-run the OLD
    image bytes. The recreate copies essential config off `container.attrs`:
    networks, mounts, env, command, entrypoint, restart policy, labels.
    """
    if docker_sdk is None:
        return {"name": name, "ok": False, "error": "docker SDK not installed in bot container"}
    try:
        client = docker_sdk.from_env()
    except (DockerException, OSError) as e:
        return {"name": name, "ok": False, "error": f"docker daemon unreachable: {e}"}
    try:
        old = client.containers.get(name)
    except DockerNotFound:
        return {"name": name, "ok": False, "error": f"no container named {name!r}"}
    except (DockerException, OSError) as e:
        return {"name": name, "ok": False, "error": f"docker inspect failed: {e}"}

    attrs = old.attrs or {}
    image_tag = (old.image.tags or [None])[0]
    current_image_id = old.image.id

    pulled = False
    pull_error = None
    new_image_id = current_image_id
    if pull and image_tag:
        try:
            img = client.images.pull(image_tag)
            new_image_id = img.id
            pulled = True
        except DockerAPIError as e:
            pull_error = str(e.explanation or e)
        except (DockerException, OSError) as e:
            pull_error = str(e)

    image_changed = pulled and new_image_id != current_image_id
    container = old
    action: str

    if image_changed:
        try:
            container = _recreate_with_image(client, old, image_tag)
            action = "recreated"
        except (DockerException, OSError, KeyError) as e:
            logger.exception("sidecar recreate failed")
            return {
                "name": name,
                "ok": False,
                "image": image_tag,
                "pulled": pulled,
                "pull_error": pull_error,
                "image_changed": True,
                "error": f"recreate failed: {e}",
            }
    else:
        try:
            old.reload()
            if old.status == "running":
                # Already syncing — let it finish, no double-run.
                action = "already-running"
            else:
                old.start()
                action = "restarted"
        except (DockerAPIError, DockerException, OSError) as e:
            return {
                "name": name,
                "ok": False,
                "image": image_tag,
                "pulled": pulled,
                "pull_error": pull_error,
                "error": f"start failed: {e}",
            }

    exit_code: Optional[int] = None
    if action != "already-running":
        try:
            result = container.wait(timeout=wait_seconds) or {}
            exit_code = result.get("StatusCode", -1)
        except Exception as e:  # pragma: no cover - defensive
            return {
                "name": name,
                "ok": False,
                "image": image_tag,
                "pulled": pulled,
                "image_changed": image_changed,
                "action": action,
                "error": f"wait failed: {e}",
            }

    try:
        tail = container.logs(tail=15, stdout=True, stderr=True).decode(errors="replace")
    except Exception:
        tail = ""

    return {
        "name": name,
        "ok": exit_code in (0, None),
        "action": action,
        "image": image_tag,
        "pulled": pulled,
        "pull_error": pull_error,
        "image_changed": image_changed,
        "exit_code": exit_code,
        "logs_tail": tail.strip()[-500:] if tail else "",
    }


def _recreate_with_image(client, old, image_tag: str):
    """Remove `old` and start a new container with the same name + essential
    config but using `image_tag`. Returns the new Container handle."""
    attrs = old.attrs or {}
    cfg = attrs.get("Config") or {}
    host = attrs.get("HostConfig") or {}
    networks = list((attrs.get("NetworkSettings") or {}).get("Networks") or {})
    name = (attrs.get("Name") or old.name).lstrip("/")

    # Compose populates HostConfig.Mounts (typed); CLI -v populates Binds.
    # Sidecars in our compose use both: named volume via Mounts, bind via Binds.
    mounts = []
    for m in host.get("Mounts") or []:
        target = m.get("Target")
        source = m.get("Source")
        mtype = m.get("Type") or "bind"
        read_only = bool(m.get("ReadOnly", False))
        if not target:
            continue
        mounts.append(
            DockerMount(
                target=target,
                source=source,
                type=mtype,
                read_only=read_only,
            )
        )

    binds = host.get("Binds") or None

    restart_policy = host.get("RestartPolicy") or {}
    if not restart_policy.get("Name") or restart_policy["Name"] == "no":
        restart_policy = None

    run_kwargs: dict = {
        "image": image_tag,
        "name": name,
        "detach": True,
        "command": cfg.get("Cmd") or None,
        "entrypoint": cfg.get("Entrypoint") or None,
        "environment": cfg.get("Env") or None,
        "working_dir": cfg.get("WorkingDir") or None,
        "labels": cfg.get("Labels") or None,
        "network": networks[0] if networks else None,
    }
    if mounts:
        run_kwargs["mounts"] = mounts
    elif binds:
        run_kwargs["volumes"] = binds
    if restart_policy:
        run_kwargs["restart_policy"] = restart_policy

    old.remove(force=True)
    return client.containers.run(
        **{k: v for k, v in run_kwargs.items() if v is not None}
    )


def _docker_action(action: str, timeout: int = 30) -> str:
    """start / stop / restart the scheduler container. Returns a one-line
    status string ready to send back to Discord. Synchronous — call via
    asyncio.to_thread from command handlers."""
    container = _docker_container()
    if isinstance(container, str):
        return f":red_circle: {container}"

    name = _scheduler_container_name()
    try:
        if action == "start":
            container.reload()
            if container.status == "running":
                return f":green_circle: `{name}` is already running."
            container.start()
            return f":green_circle: Started `{name}`."
        if action == "stop":
            container.reload()
            if container.status != "running":
                return f":yellow_circle: `{name}` is already stopped (status: {container.status})."
            container.stop(timeout=timeout)
            return f":yellow_circle: Stopped `{name}`."
        if action == "restart":
            container.restart(timeout=timeout)
            return f":green_circle: Restarted `{name}`."
        return f":red_circle: Unknown docker action: {action!r}"
    except DockerAPIError as e:
        logger.exception(f"docker {action} failed")
        return f":red_circle: docker {action} failed: `{e.explanation or e}`"
    except (DockerException, OSError) as e:
        logger.exception(f"docker {action} crashed")
        return f":red_circle: docker {action} crashed: `{e}`"


# ---------- config helpers ----------

def _guild_id() -> Optional[int]:
    raw = config["Paths"].get("discord_guild_id") or os.environ.get(
        "PUBLOADER_DISCORD_GUILD"
    )
    try:
        return int(raw) if raw else None
    except (TypeError, ValueError):
        return None


def _bot_token() -> Optional[str]:
    raw = config["Credentials"].get("discord_bot_token") or os.environ.get(
        "PUBLOADER_DISCORD_TOKEN"
    )
    if not raw:
        return None
    # configparser keeps surrounding whitespace and never strips quotes —
    # `DISCORD_BOT_TOKEN="MTxxx..."` in config.ini would otherwise be handed to
    # discord.py with the quotes still attached, producing "Improper token".
    token = raw.strip().strip("'\"").strip()
    return token or None


def _allowed_channels() -> set:
    """Channel/thread IDs the bot will accept commands from. Empty set = anywhere."""
    raw = (
        config["Paths"].get("discord_allowed_channels")
        or os.environ.get("PUBLOADER_DISCORD_CHANNELS", "")
    )
    out: set = set()
    for tok in raw.replace(",", " ").split():
        tok = tok.strip()
        if tok.isdigit():
            out.add(int(tok))
    return out


def _channel_allowed(channel_id: Optional[int]) -> bool:
    allowed = _allowed_channels()
    if not allowed:
        return True
    return channel_id in allowed


def _admin_user_ids() -> set:
    raw = (
        config["Paths"].get("discord_admin_users")
        or os.environ.get("PUBLOADER_ADMIN_USERS", "")
    )
    return {int(t) for t in raw.replace(",", " ").split() if t.strip().isdigit()}


def _admin_role_ids() -> set:
    raw = (
        config["Paths"].get("discord_admin_roles")
        or os.environ.get("PUBLOADER_ADMIN_ROLES", "")
    )
    return {int(t) for t in raw.replace(",", " ").split() if t.strip().isdigit()}


def _is_admin(user) -> bool:
    """user can be a discord.User or discord.Member. Members carry roles."""
    users = _admin_user_ids()
    roles = _admin_role_ids()
    if not users and not roles:
        return True  # no restriction configured
    if user.id in users:
        return True
    member_role_ids = {r.id for r in getattr(user, "roles", []) or []}
    return bool(member_role_ids & roles)


def _extensions_dir() -> Path:
    return Path(
        os.environ.get("PUBLOADER_EXTENSIONS_DIR", "/app/publoader/extensions/src")
    )


def _list_extensions() -> List[str]:
    try:
        return sorted(
            p.name
            for p in _extensions_dir().iterdir()
            if p.is_dir() and not p.name.startswith((".", "__"))
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return []


def _split_extensions(value: Optional[str]) -> Optional[list]:
    """For slash autocomplete fallback — accept comma/space-separated names."""
    if not value:
        return None
    parts = [p.strip() for p in value.replace(",", " ").split() if p.strip()]
    return parts or None


# ---------- bot ----------

class PubloaderBot(commands.Bot):
    def __init__(self):
        # Default (non-privileged) intents. To use prefix commands in channels,
        # enable Message Content Intent in the Developer Portal AND set
        # `intents.message_content = True` below.
        intents = discord.Intents.default()
        super().__init__(
            command_prefix=config["Paths"].get("discord_command_prefix") or "!",
            intents=intents,
        )

    async def setup_hook(self) -> None:
        # Channel gate for slash commands.
        async def _slash_check(interaction: discord.Interaction) -> bool:
            if _channel_allowed(interaction.channel_id):
                return True
            try:
                await interaction.response.send_message(
                    "This channel isn't allowed for publoader commands.",
                    ephemeral=True,
                )
            except discord.InteractionResponded:
                pass
            return False

        self.tree.interaction_check = _slash_check

        guild_id = _guild_id()
        try:
            if guild_id:
                guild = discord.Object(id=guild_id)
                self.tree.copy_global_to(guild=guild)
                synced = await self.tree.sync(guild=guild)
                logger.info(f"Synced {len(synced)} slash commands to guild {guild_id}")
            else:
                synced = await self.tree.sync()
                logger.info(f"Synced {len(synced)} global slash commands")
        except Exception:
            logger.exception("Failed to sync slash commands")

    async def on_ready(self) -> None:
        logger.info(f"Bot ready as {self.user} (id {self.user.id})")
        print(f"Bot ready as {self.user}")

    # ---------- IPC dispatch helpers ----------

    async def _dispatch(self, ctx: commands.Context, cmd: str, **payload) -> None:
        if not is_instance_running():
            await ctx.send("Publoader instance is not running.")
            return
        try:
            result = await asyncio.to_thread(ipc_call, cmd, **payload)
        except Exception as e:  # pragma: no cover - defensive
            await ctx.send(f"IPC call failed: `{e}`")
            return
        await ctx.send(f"`{cmd}` -> ```json\n{json.dumps(result, indent=2)[:1800]}\n```")

    async def _dispatch_slash(
        self, interaction: discord.Interaction, cmd: str, **payload
    ) -> None:
        # IPC is a blocking unix-socket call; defer so we don't hit the 3s
        # interaction response window.
        if not interaction.response.is_done():
            await interaction.response.defer(thinking=True)
        if not is_instance_running():
            await interaction.followup.send("Publoader instance is not running.")
            return
        try:
            result = await asyncio.to_thread(ipc_call, cmd, **payload)
        except Exception as e:  # pragma: no cover - defensive
            await interaction.followup.send(f"IPC call failed: `{e}`")
            return
        body = json.dumps(result, indent=2)[:1800]
        await interaction.followup.send(f"`{cmd}` -> ```json\n{body}\n```")

    async def build_status_embed(self) -> "discord.Embed":
        bot_latency_ms = round(self.latency * 1000) if self.latency else 0

        ipc_start = time.perf_counter()
        instance_up = is_instance_running()
        ipc_latency_ms = round((time.perf_counter() - ipc_start) * 1000)

        embed = discord.Embed(
            title="Publoader status",
            colour=discord.Colour.green() if instance_up else discord.Colour.orange(),
        )
        embed.add_field(
            name="Bot",
            value=f":green_circle: Online — `{bot_latency_ms}ms` heartbeat",
            inline=False,
        )
        embed.add_field(
            name="Scheduler (IPC)",
            value=(
                f":green_circle: Reachable — `{ipc_latency_ms}ms`"
                if instance_up
                else ":red_circle: Not running"
            ),
            inline=False,
        )

        extensions = _list_extensions()
        embed.add_field(
            name="Loaded extensions",
            value=(
                f"{len(extensions)}: " + ", ".join(extensions[:15])
                + ("…" if len(extensions) > 15 else "")
                if extensions
                else "none on disk"
            ),
            inline=False,
        )

        if instance_up:
            try:
                status = await asyncio.to_thread(ipc_call, "status")
                jobs = status.get("jobs", []) or []
                embed.add_field(name="PID", value=str(status.get("pid", "?")))
                embed.add_field(name="Scheduled jobs", value=str(len(jobs)))
                if jobs:
                    preview = "\n".join(f"• {j}" for j in jobs[:8])
                    if len(jobs) > 8:
                        preview += f"\n…and {len(jobs) - 8} more"
                    embed.add_field(
                        name="Upcoming",
                        value=f"```\n{preview[:1000]}\n```",
                        inline=False,
                    )
            except Exception as e:
                embed.add_field(name="Status fetch", value=f"failed: `{e}`", inline=False)

        return embed


# ---------- prefix-command picker UI ----------

class ExtensionPickerView(discord.ui.View):
    """Send a Select component bound to the invoking user. On submit, calls
    on_pick(interaction, picked_extensions_or_None). `__all__` resolves to None."""

    ALL_VALUE = "__all__"

    def __init__(self, on_pick, author_id: int, multi: bool = True, timeout: float = 120):
        super().__init__(timeout=timeout)
        self.on_pick = on_pick
        self.author_id = author_id

        extensions = _list_extensions()
        options = [
            discord.SelectOption(
                label="(all extensions)", value=self.ALL_VALUE, emoji="✨"
            )
        ]
        for name in extensions[:24]:  # 25-option cap minus the "all" option
            options.append(discord.SelectOption(label=name, value=name))

        self.select = discord.ui.Select(
            placeholder="Choose extension(s)…",
            options=options,
            min_values=1,
            max_values=min(len(options), 25) if multi else 1,
        )
        self.select.callback = self._on_select
        self.add_item(self.select)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message(
                "Only the user who invoked this command can pick.", ephemeral=True
            )
            return False
        return True

    async def _on_select(self, interaction: discord.Interaction):
        picked = list(self.select.values)
        if self.ALL_VALUE in picked:
            extensions = None  # "all" semantics
        else:
            extensions = picked
        for child in self.children:
            child.disabled = True
        try:
            await interaction.message.edit(view=self)
        except (discord.NotFound, discord.HTTPException):
            pass
        await self.on_pick(interaction, extensions)


async def _send_picker(bot: PubloaderBot, ctx: commands.Context, cmd: str, **base_payload):
    if not _list_extensions():
        await ctx.send("No extensions found on disk.")
        return

    async def on_pick(interaction: discord.Interaction, extensions: Optional[list]):
        payload = dict(base_payload)
        payload["extensions"] = extensions
        if not interaction.response.is_done():
            await interaction.response.defer(thinking=True)
        if not is_instance_running():
            await interaction.followup.send("Publoader instance is not running.")
            return
        try:
            result = await asyncio.to_thread(ipc_call, cmd, **payload)
        except Exception as e:
            await interaction.followup.send(f"IPC call failed: `{e}`")
            return
        body = json.dumps(result, indent=2)[:1800]
        await interaction.followup.send(f"`{cmd}` -> ```json\n{body}\n```")

    view = ExtensionPickerView(on_pick, ctx.author.id)
    await ctx.send(f"Pick extension(s) for `{cmd}`:", view=view)


# ---------- slash autocomplete ----------

async def _ext_autocomplete(
    interaction: discord.Interaction, current: str
) -> List[app_commands.Choice[str]]:
    extensions = _list_extensions()
    needle = (current or "").lower()
    return [
        app_commands.Choice(name=e, value=e)
        for e in extensions
        if not needle or needle in e.lower()
    ][:25]


# ---------- command registration ----------

def _register_commands(bot: PubloaderBot) -> None:
    # Channel gate for prefix commands.
    async def _prefix_check(ctx: commands.Context) -> bool:
        return _channel_allowed(ctx.channel.id)

    bot.add_check(_prefix_check)

    # ----- prefix commands -----
    # When called with no args, send an interactive dropdown. With explicit names,
    # dispatch directly (back-compat for typed usage).

    @bot.command(name="run")
    async def _run(ctx: commands.Context, *extensions):
        if extensions:
            await bot._dispatch(
                ctx, "run", extensions=[str(e) for e in extensions]
            )
        else:
            await _send_picker(bot, ctx, "run")

    @bot.command(name="force")
    async def _force(ctx: commands.Context, *extensions):
        if extensions:
            await bot._dispatch(
                ctx, "run", extensions=[str(e) for e in extensions], force=True
            )
        else:
            await _send_picker(bot, ctx, "run", force=True)

    @bot.command(name="clean")
    async def _clean(ctx: commands.Context, *extensions):
        if extensions:
            await bot._dispatch(
                ctx, "run", extensions=[str(e) for e in extensions], clean=True
            )
        else:
            await _send_picker(bot, ctx, "run", clean=True)

    @bot.command(name="reload")
    async def _reload(ctx: commands.Context):
        await bot._dispatch(ctx, "reload")

    @bot.command(name="start")
    async def _start(ctx: commands.Context):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await ctx.send(await asyncio.to_thread(_docker_action, "start"))

    @bot.command(name="shutdown")
    async def _shutdown(ctx: commands.Context):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await ctx.send(await asyncio.to_thread(_docker_action, "stop"))

    @bot.command(name="restart")
    async def _restart(ctx: commands.Context):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await ctx.send(await asyncio.to_thread(_docker_action, "restart"))

    @bot.command(name="status")
    async def _status(ctx: commands.Context):
        await bot._dispatch(ctx, "status")

    @bot.command(name="ping")
    async def _ping(ctx: commands.Context):
        embed = await bot.build_status_embed()
        await ctx.send(embed=embed)

    # ----- slash commands -----

    @bot.tree.command(name="ping", description="Bot heartbeat + scheduler status.")
    async def _slash_ping(interaction: discord.Interaction):
        await interaction.response.defer(thinking=True)
        embed = await bot.build_status_embed()
        await interaction.followup.send(embed=embed)

    @bot.tree.command(name="run", description="Run extensions on schedule.")
    @app_commands.describe(extension="Pick an extension (autocompletes from disk).")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_run(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction, "run", extensions=_split_extensions(extension)
        )

    @bot.tree.command(name="force", description="Force-run extensions regardless of schedule.")
    @app_commands.describe(extension="Pick an extension (autocompletes from disk).")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_force(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction,
            "run",
            extensions=_split_extensions(extension),
            force=True,
        )

    @bot.tree.command(name="clean", description="Clean run for extensions.")
    @app_commands.describe(extension="Pick an extension (autocompletes from disk).")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_clean(
        interaction: discord.Interaction, extension: Optional[str] = None
    ):
        await bot._dispatch_slash(
            interaction,
            "run",
            extensions=_split_extensions(extension),
            clean=True,
        )

    @bot.tree.command(name="reload", description="Reload extensions in-place.")
    async def _slash_reload(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "reload")

    @bot.tree.command(
        name="start",
        description="Start the scheduler container (admin-only).",
    )
    async def _slash_start(interaction: discord.Interaction):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        await interaction.followup.send(await asyncio.to_thread(_docker_action, "start"))

    @bot.tree.command(
        name="shutdown",
        description="Stop the scheduler container (admin-only).",
    )
    async def _slash_shutdown(interaction: discord.Interaction):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        await interaction.followup.send(await asyncio.to_thread(_docker_action, "stop"))

    @bot.tree.command(
        name="restart",
        description="Restart the scheduler container (admin-only). Works even if IPC is dead.",
    )
    async def _slash_restart(interaction: discord.Interaction):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        await interaction.followup.send(await asyncio.to_thread(_docker_action, "restart"))

    @bot.tree.command(name="status", description="Show scheduler PID and pending jobs.")
    async def _slash_status(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "status")

    # ----- /pull group -----
    _REPO_NAMES = ("base", "extensions", "extensions-private", "all")

    async def _repo_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> List[app_commands.Choice[str]]:
        needle = (current or "").lower()
        return [
            app_commands.Choice(name=r, value=r)
            for r in _REPO_NAMES
            if not needle or needle in r.lower()
        ][:25]

    def _parse_repo_arg(value: Optional[str]) -> List[str]:
        """Accept 'all', a single repo, or comma/space-separated repo names."""
        if not value:
            return ["all"]
        parts = [p.strip() for p in value.replace(",", " ").split() if p.strip()]
        return parts or ["all"]

    @bot.tree.command(
        name="pull",
        description="git pull the base or extension repos (admin-only).",
    )
    @app_commands.describe(
        repo="Which repo(s) to update — `all`, `base`, `extensions`, `extensions-private`.",
    )
    @app_commands.autocomplete(repo=_repo_autocomplete)
    async def _slash_pull(
        interaction: discord.Interaction, repo: Optional[str] = None
    ):
        if not _is_admin(interaction.user):
            await interaction.response.send_message(
                "You are not allowed to pull repos.", ephemeral=True
            )
            return
        await bot._dispatch_slash(
            interaction, "pull", repos=_parse_repo_arg(repo)
        )

    @bot.command(name="pull")
    async def _prefix_pull(ctx: commands.Context, *repos: str):
        if not _is_admin(ctx.author):
            await ctx.send("You are not allowed to pull repos.")
            return
        repo_list = list(repos) if repos else ["all"]
        await bot._dispatch(ctx, "pull", repos=repo_list)

    # ----- /schedule group -----
    schedule_group = app_commands.Group(
        name="schedule",
        description="Inspect or modify scheduled extension runs (admin-only).",
    )

    @schedule_group.command(
        name="list", description="Show effective schedule + DB overrides."
    )
    async def _schedule_list(interaction: discord.Interaction):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(interaction, "list_schedule")

    @schedule_group.command(
        name="set",
        description="Set or update an extension's daily schedule.",
    )
    @app_commands.describe(
        extension="Which extension to (re)schedule",
        hour="Hour 0-23 (UTC)",
        minute="Minute 0-59",
        day="Day of week 0-6 (Mon=0). Leave empty for every day.",
    )
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _schedule_set(
        interaction: discord.Interaction,
        extension: str,
        hour: app_commands.Range[int, 0, 23],
        minute: app_commands.Range[int, 0, 59],
        day: Optional[app_commands.Range[int, 0, 6]] = None,
    ):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(
            interaction,
            "set_schedule",
            extension=extension,
            hour=hour,
            minute=minute,
            day=day,
        )

    @schedule_group.command(
        name="remove",
        description="Drop an extension's DB schedule override (falls back to schedule.json).",
    )
    @app_commands.describe(extension="Extension whose override to remove")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _schedule_remove(interaction: discord.Interaction, extension: str):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(
            interaction, "remove_schedule", extension=extension
        )

    bot.tree.add_command(schedule_group)

    # ----- prefix `schedule` ----
    @bot.group(name="schedule", invoke_without_command=True)
    async def _schedule_prefix(ctx: commands.Context):
        await bot._dispatch(ctx, "list_schedule")

    @_schedule_prefix.command(name="list")
    async def _schedule_prefix_list(ctx: commands.Context):
        await bot._dispatch(ctx, "list_schedule")

    @_schedule_prefix.command(name="set")
    async def _schedule_prefix_set(
        ctx: commands.Context,
        extension: str,
        hour: int,
        minute: int,
        day: Optional[int] = None,
    ):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await bot._dispatch(
            ctx,
            "set_schedule",
            extension=extension,
            hour=hour,
            minute=minute,
            day=day,
        )

    @_schedule_prefix.command(name="remove")
    async def _schedule_prefix_remove(ctx: commands.Context, extension: str):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await bot._dispatch(ctx, "remove_schedule", extension=extension)

    # ----- /removal group: chapter expiry behaviour -----
    _REMOVAL_MODES = ("unavailable", "delete")

    async def _removal_mode_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> List[app_commands.Choice[str]]:
        needle = (current or "").lower()
        return [
            app_commands.Choice(name=m, value=m)
            for m in _REMOVAL_MODES
            if not needle or needle in m
        ]

    removal_group = app_commands.Group(
        name="removal",
        description="Control how expired chapters are dropped (unavailable vs delete).",
    )

    @removal_group.command(
        name="show",
        description="Show the current chapter-removal mode.",
    )
    async def _removal_show(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "get_removal_mode")

    @removal_group.command(
        name="set",
        description="Set chapter-removal mode globally (admin-only). Extensions can still force a mode.",
    )
    @app_commands.describe(mode="`unavailable` keeps the chapter card; `delete` removes it outright.")
    @app_commands.autocomplete(mode=_removal_mode_autocomplete)
    async def _removal_set(interaction: discord.Interaction, mode: str):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(interaction, "set_removal_mode", mode=mode)

    bot.tree.add_command(removal_group)

    @bot.group(name="removal", invoke_without_command=True)
    async def _removal_prefix(ctx: commands.Context):
        await bot._dispatch(ctx, "get_removal_mode")

    @_removal_prefix.command(name="show")
    async def _removal_prefix_show(ctx: commands.Context):
        await bot._dispatch(ctx, "get_removal_mode")

    @_removal_prefix.command(name="set")
    async def _removal_prefix_set(ctx: commands.Context, mode: str):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        await bot._dispatch(ctx, "set_removal_mode", mode=mode)

    # ----- /load /unload /extensions: runtime enable/disable -----
    # Persistently flag extensions as disabled in the state DB so the next
    # scheduled run or `/reload` skips them. Admin-only since this affects
    # what publishing actually happens.

    @bot.tree.command(
        name="load",
        description="Re-enable a previously unloaded extension (admin-only).",
    )
    @app_commands.describe(extension="Extension to load.")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_load(interaction: discord.Interaction, extension: str):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(
            interaction, "enable_extension", extension=extension
        )

    @bot.tree.command(
        name="unload",
        description="Disable an extension until it's loaded again (admin-only).",
    )
    @app_commands.describe(extension="Extension to unload.")
    @app_commands.autocomplete(extension=_ext_autocomplete)
    async def _slash_unload(interaction: discord.Interaction, extension: str):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await bot._dispatch_slash(
            interaction, "disable_extension", extension=extension
        )

    @bot.tree.command(
        name="extensions",
        description="List extensions on disk and whether each is loaded.",
    )
    async def _slash_extensions(interaction: discord.Interaction):
        await bot._dispatch_slash(interaction, "list_extensions")

    @bot.command(name="load")
    async def _prefix_load(ctx: commands.Context, extension: Optional[str] = None):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        if not extension:
            await ctx.send("Usage: `!load <extension>`")
            return
        await bot._dispatch(ctx, "enable_extension", extension=extension)

    @bot.command(name="unload")
    async def _prefix_unload(ctx: commands.Context, extension: Optional[str] = None):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        if not extension:
            await ctx.send("Usage: `!unload <extension>`")
            return
        await bot._dispatch(ctx, "disable_extension", extension=extension)

    @bot.command(name="extensions")
    async def _prefix_extensions(ctx: commands.Context):
        await bot._dispatch(ctx, "list_extensions")

    # ----- /refresh: pull extensions sidecar image + re-run sync -----
    # The named extensions volume is populated by the sidecars' sync_extensions.py.
    # /pull and watchtower's daily check don't refresh one-shot sidecars, so this
    # command is the canonical way to get a new MangaDex group / extension push
    # live without redeploying compose.

    async def _do_refresh(reload_after: bool, pull: bool) -> List[dict]:
        names = _extension_sidecar_names()
        out: List[dict] = []
        for n in names:
            out.append(await asyncio.to_thread(_refresh_sidecar, n, pull))
        if reload_after and is_instance_running():
            try:
                out.append(
                    {"name": "scheduler-reload", **await asyncio.to_thread(ipc_call, "reload")}
                )
            except Exception as e:  # pragma: no cover - defensive
                out.append({"name": "scheduler-reload", "ok": False, "error": str(e)})
        return out

    def _format_refresh(results: List[dict]) -> str:
        lines = []
        for r in results:
            icon = ":green_circle:" if r.get("ok") else ":red_circle:"
            name = r.get("name", "?")
            if r.get("name") == "scheduler-reload":
                lines.append(f"{icon} scheduler reload — `{r.get('ok')}`")
                continue
            parts = [f"image={r.get('image') or '?'}"]
            if r.get("pulled"):
                parts.append("pulled")
            if r.get("pull_error"):
                parts.append(f"pull-error: {r['pull_error']}")
            if r.get("image_changed"):
                parts.append("image-changed")
            parts.append(f"action={r.get('action') or '?'}")
            if r.get("exit_code") is not None:
                parts.append(f"exit={r['exit_code']}")
            if r.get("error"):
                parts.append(f"error: {r['error']}")
            lines.append(f"{icon} `{name}` — " + ", ".join(parts))
            tail = (r.get("logs_tail") or "").strip()
            if tail:
                lines.append(f"```\n{tail[-400:]}\n```")
        return "\n".join(lines) or "no sidecars configured."

    @bot.tree.command(
        name="refresh",
        description="Pull the extensions sidecar image and re-run sync (admin-only).",
    )
    @app_commands.describe(
        nopull="Skip the docker pull and just re-run sync with the current image.",
        noreload="Don't trigger a scheduler reload after sync.",
    )
    async def _slash_refresh(
        interaction: discord.Interaction,
        nopull: Optional[bool] = False,
        noreload: Optional[bool] = False,
    ):
        if not _is_admin(interaction.user):
            await interaction.response.send_message("Not allowed.", ephemeral=True)
            return
        await interaction.response.defer(thinking=True)
        results = await _do_refresh(
            reload_after=not noreload, pull=not nopull
        )
        await interaction.followup.send(_format_refresh(results)[:1900])

    @bot.command(name="refresh")
    async def _prefix_refresh(ctx: commands.Context, *flags: str):
        if not _is_admin(ctx.author):
            await ctx.send("Not allowed.")
            return
        flag_set = {f.lstrip("-").lower() for f in flags}
        pull = "nopull" not in flag_set
        reload_after = "noreload" not in flag_set
        results = await _do_refresh(reload_after=reload_after, pull=pull)
        await ctx.send(_format_refresh(results)[:1900])

def run() -> int:
    token = _bot_token()
    if not token:
        logger.error("No discord bot token configured; bot will not start.")
        print("No discord bot token configured.")
        return 1

    bot = PubloaderBot()
    _register_commands(bot)
    try:
        bot.run(token)
    except discord.PrivilegedIntentsRequired:
        msg = (
            "Bot login rejected: a privileged intent is requested but disabled in "
            "the Developer Portal. Either enable the matching toggle under "
            "'Bot -> Privileged Gateway Intents' or remove the intent in "
            "PubloaderBot.__init__."
        )
        logger.error(msg)
        print(msg)
        return 1
    except discord.LoginFailure as e:
        hint = (
            "  Check config.ini [Credentials] DISCORD_BOT_TOKEN — make sure it's "
            "the *bot* token from the Developer Portal (not the client secret / "
            "OAuth secret / public key), with no surrounding quotes. If you "
            "recently regenerated the token, the old one is permanently revoked."
        )
        logger.error(f"Bot login failed: {e}\n{hint}")
        print(f"Bot login failed: {e}\n{hint}")
        return 1
    except Exception:
        logger.exception("Discord bot crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
