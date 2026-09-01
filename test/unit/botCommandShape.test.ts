import { describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/bot/commands.js";

/**
 * Discord's own validation of the command set, applied here instead of in
 * production.
 *
 * The whole command set is registered in one PUT, so a single malformed option
 * is not a partial failure — Discord rejects the batch with a 400 and *nothing*
 * is registered, in any guild. Worse, it fails quietly in a way that looks like
 * success: a guild keeps whatever was registered last time, so a stale command
 * list goes on working while every deploy silently fails to replace it. That is
 * exactly what happened with `/permissions set-user`, and it was only noticed
 * when a second guild — which had no stale set to fall back on — showed nothing
 * at all.
 *
 * These assertions are cheap and they run against the real builders, so the
 * next one is caught before it ships rather than by reading a container log.
 */

type Option = { name: string; type: number; required?: boolean; options?: Option[] };

const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;
const isContainer = (option: Option): boolean =>
  option.type === SUBCOMMAND || option.type === SUBCOMMAND_GROUP;

/** Every `(path, options[])` pair that Discord will validate as a unit. */
function optionGroups(): { path: string; options: Option[] }[] {
  const groups: { path: string; options: Option[] }[] = [];
  const walk = (path: string, options: Option[] | undefined): void => {
    if (!options || options.length === 0) return;
    // A container's children are subcommands, not parameters; the ordering rule
    // applies to the leaf parameter lists.
    if (options.some(isContainer)) {
      for (const child of options) walk(`${path} ${child.name}`, child.options);
      return;
    }
    groups.push({ path, options });
  };
  for (const command of ALL_COMMANDS) {
    const json = command.builder.toJSON() as { name: string; options?: Option[] };
    walk(`/${json.name}`, json.options);
  }
  return groups;
}

describe("slash command shape", () => {
  it("puts every required option before the optional ones", () => {
    // Discord: APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID. One violation
    // anywhere rejects the entire registration for every guild.
    const offenders: string[] = [];
    for (const { path, options } of optionGroups()) {
      let seenOptional: string | null = null;
      for (const option of options) {
        if (option.required) {
          if (seenOptional !== null) {
            offenders.push(`${path}: required \`${option.name}\` follows optional \`${seenOptional}\``);
          }
        } else {
          seenOptional ??= option.name;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every command within Discord's 25-option limit", () => {
    const offenders = optionGroups()
      .filter((group) => group.options.length > 25)
      .map((group) => `${group.path}: ${group.options.length} options`);
    expect(offenders).toEqual([]);
  });

  it("registers at most 100 commands, which is the per-guild cap", () => {
    expect(ALL_COMMANDS.length).toBeLessThanOrEqual(100);
  });

  it("has no duplicate command names, which Discord also rejects outright", () => {
    const names = ALL_COMMANDS.map((c) => (c.builder.toJSON() as { name: string }).name);
    expect(names).toEqual([...new Set(names)]);
  });
});
