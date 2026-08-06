import type { LoginTokenPurpose } from "@prisma/client";
import type { OutgoingEmail } from "./mailer.js";

/**
 * The messages themselves.
 *
 * Kept as plain functions returning `{subject, html, text}` so they can be
 * asserted on in a unit test without a provider, a template service or a
 * render step. Every one carries the link as visible text as well as an
 * anchor: link-rewriting scanners, plaintext readers and copy-paste all have
 * to work, because this link is sometimes the only way into an account.
 */

const BRAND = "publoader";

/** Everything interpolated into the HTML is attacker-influenced somewhere. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function minutes(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

interface Body {
  heading: string;
  /** Paragraphs above the button. */
  intro: string[];
  action: { label: string; url: string };
  /** Paragraphs below the link, before the footer. */
  outro: string[];
}

/**
 * One layout for every message. Table-free, inline-styled and light-scheme:
 * transactional mail is read in clients with no CSS support worth the name,
 * and a sign-in button that fails to render is a locked-out operator.
 */
function layout(body: Body): { html: string; text: string } {
  const paragraphs = (list: string[], style: string) =>
    list.map((line) => `<p style="${style}">${escapeHtml(line)}</p>`).join("\n      ");

  const base = "margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2328;";
  const dim = "margin:0 0 12px;font-size:13px;line-height:1.6;color:#57606a;";

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:10px;padding:32px;">
      <p style="margin:0 0 24px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#8250df;font-weight:600;">${BRAND}</p>
      <h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;color:#1f2328;">${escapeHtml(body.heading)}</h1>
      ${paragraphs(body.intro, base)}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(body.action.url)}" style="display:inline-block;padding:12px 20px;background:#8250df;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600;">${escapeHtml(body.action.label)}</a>
      </p>
      <p style="${dim}">Or paste this address into your browser:</p>
      <p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;color:#0969da;">${escapeHtml(body.action.url)}</p>
      ${paragraphs(body.outro, dim)}
    </div>
  </body>
</html>`;

  const text = [
    BRAND.toUpperCase(),
    "",
    body.heading,
    "",
    ...body.intro,
    "",
    `${body.action.label}: ${body.action.url}`,
    "",
    ...body.outro,
    "",
  ].join("\n");

  return { html, text };
}

export interface LinkEmailInput {
  purpose: LoginTokenPurpose;
  to: string;
  url: string;
  ttlSeconds: number;
  /** Present on INVITE and WELCOME so the recipient knows what they can do. */
  role?: string;
  /** True when the account still has no password; the link is its only key. */
  needsPassword: boolean;
}

const NOT_YOU =
  "If you did not expect this email, ignore it; the link only works once and expires on its own.";

/** The one message that matters: a link that signs the recipient in. */
export function linkEmail(input: LinkEmailInput): OutgoingEmail {
  const lifetime = minutes(input.ttlSeconds);
  const setPassword = input.needsPassword
    ? "Once you are in, set a password from the profile menu → Your account. Until you do, this " +
      "emailed link is the only way to sign in."
    : "";

  const byPurpose: Record<LoginTokenPurpose, { subject: string; body: Body }> = {
    LOGIN: {
      subject: `Sign in to ${BRAND}`,
      body: {
        heading: "Your sign-in link",
        intro: [
          `Someone asked to sign in to the ${BRAND} control plane as ${input.to}.`,
          `This link works once and expires in ${lifetime}.`,
        ],
        action: { label: "Sign in", url: input.url },
        outro: [setPassword, NOT_YOU].filter(Boolean),
      },
    },
    INVITE: {
      subject: `You have been invited to ${BRAND}`,
      body: {
        heading: `You have been invited to the ${BRAND} control plane`,
        intro: [
          input.role
            ? `An owner created an account for ${input.to} with the ${input.role} role.`
            : `An owner created an account for ${input.to}.`,
          `Use the link below to sign in for the first time. It works once and expires in ${lifetime}.`,
        ],
        action: { label: "Accept the invitation", url: input.url },
        outro: [
          setPassword,
          "If the link has expired, ask an owner to send you a new one, or request one yourself from the sign-in page.",
        ].filter(Boolean),
      },
    },
    WELCOME: {
      subject: `Your ${BRAND} account is ready`,
      body: {
        heading: "Your account has been approved",
        intro: [
          input.role
            ? `The account for ${input.to} has been approved with the ${input.role} role.`
            : `The account for ${input.to} has been approved.`,
          `Use the link below to sign in. It works once and expires in ${lifetime}.`,
        ],
        action: { label: "Sign in", url: input.url },
        outro: [setPassword, NOT_YOU].filter(Boolean),
      },
    },
  };

  const chosen = byPurpose[input.purpose];
  return { to: input.to, subject: chosen.subject, ...layout(chosen.body) };
}

/**
 * Self-signup landed, but an owner has to approve it before there is anything
 * to sign in to. Sent instead of a link so the request is acknowledged rather
 * than silently swallowed; and so the address is told it was used.
 */
export function signupPendingEmail(to: string, dashUrl: string): OutgoingEmail {
  const body: Body = {
    heading: "Your account is waiting for approval",
    intro: [
      `An account for ${to} was created on the ${BRAND} control plane.`,
      "An owner has to approve it before it can be used. You will get a sign-in link by email once that happens.",
    ],
    action: { label: `Open ${BRAND}`, url: dashUrl },
    outro: [NOT_YOU],
  };
  return { to, subject: `Your ${BRAND} account is awaiting approval`, ...layout(body) };
}

/**
 * A password was set or replaced. Not a link; a notice, so that a password
 * change the account holder did not make is visible to them immediately.
 */
export function passwordChangedEmail(to: string, dashUrl: string): OutgoingEmail {
  const body: Body = {
    heading: "Your password was changed",
    intro: [
      `The password for ${to} on the ${BRAND} control plane was just set.`,
      "You can now sign in with your email and password. Any outstanding email sign-in links have been retired.",
    ],
    action: { label: "Open the control plane", url: dashUrl },
    outro: [
      "If this was not you, sign in and change it immediately, then ask an owner to revoke your other sessions.",
    ],
  };
  return { to, subject: `Your ${BRAND} password was changed`, ...layout(body) };
}
