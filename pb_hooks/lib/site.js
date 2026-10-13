/// <reference path="../../types/pocketbase.d.ts" />
// Invite-only signups (DESIGN.md §24): while the `site` record says invite_only, a new account needs its invite_code
// (sent as `invite_code` with the signup). Superusers create accounts as they like.

/**
 * The site record (the oldest, should a second one be added), or null without one.
 * @param {core.App} app
 */
function siteOf(app) {
  const found = app.findRecordsByFilter("site", "", "created", 1, 0);
  return found.length ? found[0] : null;
}

/**
 * users create request: refuse a signup without the invite code while the site is invite-only.
 * @param {core.RecordRequestEvent} e
 */
function checkInvite(e) {
  if (e.hasSuperuserAuth()) return;
  const site = siteOf(e.app);
  if (!site?.getBool("invite_only")) return;
  const want = site.getString("invite_code").trim();
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const got = typeof body.invite_code === "string" ? body.invite_code.trim() : "";
  if (want !== "" && got !== "" && $security.equal(got, want)) return;
  const [code, message] =
    want === ""
      ? ["validation_signups_closed", "Signing up is closed."]
      : got === ""
        ? ["validation_required", "Enter your invite code."]
        : ["validation_invalid_invite", "This invite code isn't valid."];
  throw new BadRequestError("Failed to create record.", { invite_code: new ValidationError(code, message) });
}

/**
 * users OAuth2 login: no new accounts this way while the site is invite-only (there is no code to check).
 * @param {core.RecordAuthWithOAuth2RequestEvent} e
 */
function checkOAuth2Signup(e) {
  if (e.isNewRecord && siteOf(e.app)?.getBool("invite_only")) throw new ForbiddenError("Signing up is by invitation only.");
}

module.exports = { checkInvite, checkOAuth2Signup };
