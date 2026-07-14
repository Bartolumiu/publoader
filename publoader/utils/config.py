import configparser
import logging
import re
from calendar import WEDNESDAY
from datetime import time

from publoader.utils.utils import root_path

logger = logging.getLogger("publoader")


def load_config_info(config: configparser.RawConfigParser):
    if config["Paths"].get("mangadex_api_url", "") == "":
        logger.warning("Mangadex api path empty, using default.")
        config["Paths"]["mangadex_api_url"] = "https://api.mangadex.org"

    if config["Paths"].get("mangadex_auth_url", "") == "":
        logger.warning("Mangadex auth path empty, using default.")
        config["Paths"][
            "mangadex_auth_url"
        ] = "https://auth.mangadex.org/realms/mangadex/protocol/openid-connect"

    if config["Paths"].get("mdauth_path", "") == "":
        logger.info("Mdauth path empty, using default.")
        config["Paths"]["mdauth_path"] = "resources/mdauth.json"

    if config["Paths"].get("commits_path", "") == "":
        logger.info("Commits path empty, using default.")
        config["Paths"]["commits_path"] = ".commits"

    if config["Paths"].get("resources_path", "") == "":
        logger.info("Resources path empty, using default.")
        config["Paths"]["resources_path"] = "resources"

    if config["Paths"].get("manga_data_path", "") == "":
        logger.info("Manga data path empty, using default.")
        config["Paths"]["manga_data_path"] = "manga_data.json"

    if config["Repo"].get("repo_owner", "") == "":
        config["Repo"]["repo_owner"] = "ArdaxHz"

    if config["Repo"].get("base_repo_path", "") == "":
        config["Repo"]["base_repo_path"] = "publoader"

    if config["Repo"].get("extensions_repo_path", "") == "":
        config["Repo"]["extensions_repo_path"] = "publoader-extensions"


def open_config_file() -> configparser.RawConfigParser:
    if config_file_path.exists():
        config = configparser.RawConfigParser()
        config.read(config_file_path)
        logger.info("Loaded config file.")
    else:
        logger.critical("Config file not found, exiting.")
        raise FileNotFoundError("Config file not found.")

    load_config_info(config)
    return config


config_file_path = root_path.joinpath("config").with_suffix(".ini")
config = open_config_file()
resources_path = root_path.joinpath(config["Paths"]["resources_path"])
resources_path.mkdir(parents=True, exist_ok=True)

mangadex_api_url = config["Paths"]["mangadex_api_url"]
mangadex_auth_url = config["Paths"]["mangadex_auth_url"]
md_upload_api_url = f"{mangadex_api_url}/upload"


try:
    ratelimit_time = int(config["Options"].get("mangadex_ratelimit_time", ""))
except (ValueError, KeyError):
    ratelimit_time = 2


try:
    upload_retry = int(config["Options"].get("upload_retry", ""))
except (ValueError, KeyError):
    upload_retry = 3

try:
    max_requests = int(config["Options"].get("max_requests", ""))
except (ValueError, KeyError):
    max_requests = 5


try:
    max_log_days = int(config["Options"].get("max_log_days", ""))
except (ValueError, KeyError):
    max_log_days = 30


try:
    daily_run_time_daily_hour = int(
        config["Options"].get("bot_run_time_daily", "").split(":")[0]
    )
except (ValueError, KeyError):
    daily_run_time_daily_hour = 15

try:
    daily_run_time_daily_minute = int(
        config["Options"].get("bot_run_time_daily", "").split(":")[1]
    )
except (ValueError, KeyError):
    daily_run_time_daily_minute = 0

try:
    daily_run_time_checks_hour = int(
        config["Options"].get("bot_run_time_checks", "").split(":")[0]
    )
except (ValueError, KeyError):
    daily_run_time_checks_hour = 1

try:
    daily_run_time_checks_minute = int(
        config["Options"].get("bot_run_time_checks", "").split(":")[1]
    )
except (ValueError, KeyError):
    daily_run_time_checks_minute = 0

DEFAULT_TIME = time(hour=daily_run_time_daily_hour, minute=daily_run_time_daily_minute)
CLEAN_TIME = time(hour=daily_run_time_checks_hour, minute=daily_run_time_checks_minute)
DEFAULT_CLEAN_DAY = WEDNESDAY
ALL_DAYS = range(7)


def _config_get(section: str, option: str, fallback: str = "") -> str:
    """Read [section]option, tolerating a missing section entirely."""
    try:
        return config[section].get(option, fallback)
    except KeyError:
        return fallback


# GitHub push-webhook listener. When enabled, GitHub fires an HTTP POST the
# moment code is pushed to a tracked repo, so updates download immediately
# instead of waiting for the daily restart job (which stays as a fallback).
github_webhook_enabled = _config_get(
    "GithubWebhook", "enabled", "false"
).strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
github_webhook_host = _config_get("GithubWebhook", "host", "0.0.0.0") or "0.0.0.0"

try:
    github_webhook_port = int(_config_get("GithubWebhook", "port", "9000") or "9000")
except ValueError:
    github_webhook_port = 9000

github_webhook_path = _config_get("GithubWebhook", "path", "/webhook") or "/webhook"
if not github_webhook_path.startswith("/"):
    github_webhook_path = "/" + github_webhook_path

# Shared secret configured on the GitHub webhook; used to verify the
# X-Hub-Signature-256 HMAC of each delivery. The listener refuses to start
# without one (an unauthenticated update trigger would be a remote-code path).
github_webhook_secret = _config_get("GithubWebhook", "secret", "") or ""


# Outgoing-IP rotation. Spread MangaDex requests across multiple source IPs so
# no single address trips a per-IP rate-limit ban. All optional; blank = the
# default single outbound IP. See publoader/http/rotation.py and docker/README.
# Proxy URLs, comma/newline separated. A random one is used per request.
outgoing_proxies = [
    p.strip()
    for p in re.split(r"[,\n]", _config_get("Network", "proxies", ""))
    if p.strip()
]
# Explicit local source IPs to bind to, comma/space/newline separated.
outgoing_source_ips = [
    p.strip()
    for p in re.split(r"[,\s]+", _config_get("Network", "source_ips", ""))
    if p.strip()
]
# Routed IPv6 subnet (CIDR) to generate rotating source addresses from.
outgoing_source_ipv6_subnet = _config_get("Network", "source_ipv6_subnet", "").strip()

try:
    outgoing_source_pool_size = int(
        _config_get("Network", "source_ip_pool_size", "64") or "64"
    )
except ValueError:
    outgoing_source_pool_size = 64
if outgoing_source_pool_size < 1:
    outgoing_source_pool_size = 1


def _mongo_hosts(uri: str) -> "list[str]":
    """Extract host name(s) from a MongoDB connection string, no DNS lookups.

    Handles ``mongodb://`` and ``mongodb+srv://``, optional ``user:pass@``
    userinfo, comma-separated replica-set members, ports, and bracketed IPv6
    literals. Returns lower-cased hosts (empty list for a blank/garbled URI).
    """
    if not uri:
        return []
    rest = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", uri.strip())
    # Only the host section: everything before the first '/' or '?'.
    hostpart = re.split(r"[/?]", rest, maxsplit=1)[0]
    if "@" in hostpart:  # strip userinfo
        hostpart = hostpart.rsplit("@", 1)[1]
    hosts = []
    for node in hostpart.split(","):
        node = node.strip()
        if not node:
            continue
        if node.startswith("["):  # [::1]:27017
            host = node[1:].split("]", 1)[0]
        else:
            host = node.split(":", 1)[0]
        host = host.strip().lower()
        if host:
            hosts.append(host)
    return hosts


# Hosts that must NEVER be routed through the outgoing proxy pool. The MongoDB
# host(s) head the list — database traffic must go direct (see
# publoader/http/rotation.py). localhost is always included so in-process/IPC
# HTTP stays local, and users can add more (e.g. a cert's OCSP responder) via
# [Network] no_proxy. Merged with the standard NO_PROXY env var in rotation.py.
no_proxy_hosts = ["localhost", "127.0.0.1", "::1"]
no_proxy_hosts += _mongo_hosts(_config_get("Credentials", "mongodb_uri", ""))
no_proxy_hosts += [
    p.strip()
    for p in re.split(r"[,\s]+", _config_get("Network", "no_proxy", ""))
    if p.strip()
]
