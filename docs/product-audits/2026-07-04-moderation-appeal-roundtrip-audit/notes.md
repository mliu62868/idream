# Moderation Appeal Roundtrip Audit

Date: 2026-07-04

## Scope

Chrome end-to-end audit of a public user-created character moving through report, admin action, public removal, creator appeal, admin overturn, and public restoration.

## Fixture

- Main URL: `http://moderation-public-1783164006.localhost:3130`
- Creator URL: `http://moderation-creator-1783164006.localhost:3130`
- Admin URL: `http://localhost:3001/admin/moderation`
- Creator user: `chrome-moderation-1783164006@test.local`
- Creator user id: `cmr69tsh10002djl7j3f66ccj`
- Character id: `chrome-moderation-character-1783164006`
- Character name: `Chrome Moderation 1783164006`
- Report id: `cmr69vv71000edjl7lf8gg8ng`
- Appeal id: `cmr69z6d8000hdjl7s6madosu`

## Evidence

- `screenshots/01-public-search-visible.png` - fresh public visitor sees the approved character in search.
- `screenshots/02-public-detail-report-action.png` - public character detail exposes the Report action.
- `screenshots/03-report-submitted.png` - anonymous public report succeeds and enters review.
- `screenshots/04-admin-report-open.png` - Admin Moderation Reports queue shows the new open report.
- `screenshots/05-admin-report-actioned.png` - admin action completes and removes the report from the open queue.
- `screenshots/06-public-detail-hidden-after-action.png` - direct public detail URL no longer renders the character.
- `screenshots/07-public-search-hidden-after-action.png` - public search no longer lists the character after action.
- `screenshots/08-helpdesk-appeal-submitted.png` - creator submits an appeal through Help Desk.
- `screenshots/09-admin-appeal-open.png` - Admin Moderation Appeals queue shows the open appeal.
- `screenshots/10-admin-appeal-overturned.png` - admin Overturn completes and removes the appeal from the open queue.
- `screenshots/11-public-search-restored-after-overturn.png` - public search lists the character again.
- `screenshots/12-public-detail-restored-after-overturn.png` - public detail renders again with Chat, Generate, Like, and Report actions.

## Result

Pass for the audited product loop.

- Anonymous, age-gated public reporting works and writes an open `ContentReport` with `reporterId=null`.
- Admin report action changes the target character away from public discovery; both search and direct detail stop showing it.
- Creator Help Desk appeal writes an open `Appeal` tied to the creator account and target character.
- Admin Overturn restores the character to `visibility=public` and `status=approved`; search and detail recover without manual DB edits.
- Admin audit rows were written for both the report decision and appeal decision.
- Fresh Chrome checks after reload showed no current console `error`, `warn`, or `issue` messages on Admin Moderation or public character detail.

## Final DB State Before Cleanup

```json
{
  "character": {
    "id": "chrome-moderation-character-1783164006",
    "visibility": "public",
    "status": "approved",
    "creatorId": "cmr69tsh10002djl7j3f66ccj"
  },
  "report": {
    "id": "cmr69vv71000edjl7lf8gg8ng",
    "status": "actioned",
    "targetType": "character",
    "targetId": "chrome-moderation-character-1783164006",
    "reporterId": null
  },
  "appeal": {
    "id": "cmr69z6d8000hdjl7s6madosu",
    "status": "overturned",
    "targetType": "character",
    "targetId": "chrome-moderation-character-1783164006",
    "originalDecisionId": "cmr69vv71000edjl7lf8gg8ng",
    "reviewerId": "seed-admin-user"
  },
  "audits": [
    "safety.review.decision",
    "safety.appeal.decision"
  ],
  "moderationEvents": [
    {
      "layer": "community_report",
      "status": "flagged",
      "policyCode": "other_prohibited_content"
    }
  ]
}
```

## Product Gap

P2 usability gap: the current Help Desk appeal form is operationally complete, but a normal creator has to know or copy raw `targetId` and decision/report id values. Before broader creator use, add a direct `Appeal this decision` entry from a removed-character notice, notification, or My AI removed/pending state so the form can prefill the target and decision context.

## Cleanup

Completed after evidence capture. Targeted cleanup deleted the fixture user, character, report, appeal, moderation review, moderation event, and two admin audit rows. Verification counts after cleanup:

```json
{
  "user": 0,
  "character": 0,
  "report": 0,
  "appeal": 0,
  "moderationReview": 0,
  "moderationEvent": 0,
  "adminAuditLog": 0
}
```
