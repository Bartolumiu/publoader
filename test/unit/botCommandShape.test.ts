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

  it("gives every command and option a name Discord will accept", () => {
    // CHAT_INPUT names must be lowercase and match Discord's character class;
    // a capital letter or a space is a 400 for the entire batch.
    const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;
    const offenders: string[] = [];
    const checkName = (path: string, name: string): void => {
      if (!NAME.test(name)) offenders.push(`${path}: "${name}" is not a valid name`);
      if (name !== name.toLowerCase()) offenders.push(`${path}: "${name}" is not lowercase`);
    };
    for (const command of ALL_COMMANDS) {
      const json = command.builder.toJSON() as { name: string; options?: Option[] };
      checkName("command", json.name);
      const walk = (path: string, options: Option[] | undefined): void => {
        for (const option of options ?? []) {
          checkName(path, option.name);
          walk(`${path} ${option.name}`, option.options);
        }
      };
      walk(`/${json.name}`, json.options);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every description within Discord's 100-character limit", () => {
    const offenders: string[] = [];
    const check = (path: string, description: unknown): void => {
      const text = typeof description === "string" ? description : "";
      if (text.length === 0) offenders.push(`${path}: empty description`);
      if (text.length > 100) offenders.push(`${path}: description is ${text.length} chars`);
    };
    for (const command of ALL_COMMANDS) {
      const json = command.builder.toJSON() as { name: string; description?: string; options?: Option[] };
      check(`/${json.name}`, json.description);
      const walk = (path: string, options: Option[] | undefined): void => {
        for (const option of options ?? []) {
          check(`${path} ${option.name}`, (option as { description?: string }).description);
          walk(`${path} ${option.name}`, option.options);
        }
      };
      walk(`/${json.name}`, json.options);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps choice lists legal, and never pairs choices with autocomplete", () => {
    // Discord rejects an option that offers both a fixed choice list and
    // autocomplete; they are alternative ways to fill the same box.
    const offenders: string[] = [];
    const walk = (path: string, options: Option[] | undefined): void => {
      for (const option of options ?? []) {
        const withExtras = option as { choices?: { name: string; value: unknown }[]; autocomplete?: boolean };
        const choices = withExtras.choices;
        if (choices) {
          if (choices.length > 25) offenders.push(`${path} ${option.name}: ${choices.length} choices`);
          if (withExtras.autocomplete) offenders.push(`${path} ${option.name}: choices AND autocomplete`);
          for (const choice of choices) {
            if (choice.name.length < 1 || choice.name.length > 100) {
              offenders.push(`${path} ${option.name}: choice name "${choice.name}" is out of range`);
            }
            if (typeof choice.value === "string" && choice.value.length > 100) {
              offenders.push(`${path} ${option.name}: choice value is over 100 chars`);
            }
          }
        }
        walk(`${path} ${option.name}`, option.options);
      }
    };
    for (const command of ALL_COMMANDS) {
      const json = command.builder.toJSON() as { name: string; options?: Option[] };
      walk(`/${json.name}`, json.options);
    }
    expect(offenders).toEqual([]);
  });

  it("nests no deeper than group → subcommand → option", () => {
    const offenders: string[] = [];
    for (const command of ALL_COMMANDS) {
      const json = command.builder.toJSON() as { name: string; options?: Option[] };
      const walk = (path: string, options: Option[] | undefined, depth: number): void => {
        for (const option of options ?? []) {
          if (isContainer(option) && depth >= 2) {
            offenders.push(`${path} ${option.name}: nested too deep`);
          }
          walk(`${path} ${option.name}`, option.options, depth + 1);
        }
      };
      walk(`/${json.name}`, json.options, 0);
    }
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
