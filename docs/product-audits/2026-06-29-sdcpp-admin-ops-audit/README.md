# sdcpp Admin Model Import Ops Audit

Date: 2026-06-29

Scope: `/admin/generation/config`, specifically the sdcpp local model import path for main `.safetensors` models, LoRA `.safetensors` assets, conversion-to-GGUF configuration, and the handoff into model profile drafts.

Review stance: adversarial operator review. Assume the operator is busy, not an sdcpp engineer, uploading multi-GB files, and must avoid publishing a broken model profile.

## Evidence

- `01-entry-full-page.png`: existing logged-in admin page in Chrome plugin session.
- `02-login-form.png`: cold browser admin login state.
- `02-playwright-entry.png`: authenticated Chrome/Playwright entry state.
- `03-after-main-upload.png`: after uploading a dummy main `.safetensors` file.
- `04-after-lora-upload.png`: after uploading a dummy LoRA `.safetensors` file.

Upload artifacts were dummy local files and were removed after screenshot capture.

## Verified

- The page is reachable at `http://127.0.0.1:3010/admin/generation/config`.
- The sdcpp import UI is present under `Generation Config`.
- Main `.safetensors` upload populates key profile fields:
  - `Profile Key`
  - `Label`
  - `Pipeline Model`
  - `Source Model`
  - `Diffusion Model`
  - `Converted Model`
  - `Convert to GGUF`
- LoRA `.safetensors` upload adds a LoRA row and updates `LoRA Stack` to `1 total`.
- No browser console errors or page errors were observed during the Playwright upload flow.

## Findings

### P0/P1: Import Is Technically Present But Operationally Buried

Operators do not get a dedicated `sdcpp Models` or `Model Library` page. The workflow is nested inside `Generation Config`, beneath the broader `Create Model Profile Draft` form. A new operator can plausibly miss it or misunderstand whether import, profile creation, dry run, and publish are one workflow or separate workflows.

Recommended fix: add a first-class admin route/nav item for `Models` or `sdcpp Models`, with tabs for `Assets`, `Profiles`, `Conversions`, and `LoRA Stacks`. Keep the current form as an advanced/details surface, not the primary entry.

### P1: No Clear Step-by-Step State Machine

After uploading the main model, the form is populated, but there is no explicit progress state like:

1. File uploaded
2. Metadata recognized
3. GGUF conversion target prepared
4. LoRA stack attached
5. Draft ready
6. Dry run required
7. Publish eligible

The `Create Draft` button is at the top before the operator has reviewed the generated configuration. This makes accidental or premature draft creation more likely.

Recommended fix: make the flow wizard-like or add a sticky readiness panel with validation checks and a primary action at the bottom: `Create Draft and Run Dry Run`.

### P1: Large File Upload Needs Production-Grade Feedback

The UI accepts local `.safetensors`, but for real multi-GB model files there is no visible progress, speed, remaining time, cancel, retry, checksum, duplicate warning, free disk space warning, or resumability. An operator cannot tell whether the page is working or frozen.

Recommended fix: treat model import as a job with upload progress, storage destination, checksum, size limit, queue state, and retry/cancel controls. For local server paths, add a safer `Register server file` path with existence/permission validation before submission.

### P1: Asset Library and Profile Concepts Are Blurred

The screen mixes uploaded assets, registered paths, model profiles, conversion targets, and publish actions. `Select from model library` lists assets, while the table below lists model profiles. Operators need clear object labels:

- Uploaded asset
- Registered server file
- Converted GGUF artifact
- Draft model profile
- Active model profile
- LoRA stack item

Recommended fix: show a concise object summary card after import: `Main model asset -> profile draft -> GGUF output -> LoRA stack -> dry-run status`.

### P1: LoRA Stack Has Two Sources of Truth

LoRA upload adds a visible row and also exposes raw JSON. The JSON is useful for engineers but dangerous as a primary operator control. Operators may edit the JSON and not understand whether it overrides the row UI.

Recommended fix: collapse raw JSON under `Advanced JSON`, make row controls authoritative, and show validation if JSON is manually edited.

### P2: Dry Run Is Too Far From Import

The dry-run action lives in the profile table after draft creation. On a 1440px-wide viewport, table action buttons are horizontally far off-screen due to the wide table. Operators may not find `Dry Run` after creating a model.

Recommended fix: after draft creation, keep the operator in the import flow and show `Run Dry Run` as the next primary action. The profile table should have sticky identity and action columns.

### P2: Raw Paths Dominate the Visual Hierarchy

Long filesystem paths consume much of the form and hide the operational meaning. The most important facts are not visually elevated: main model name, format, storage location, conversion target, LoRA count, and publish readiness.

Recommended fix: render paths as truncated chips with copy/open actions, and show the human-readable summary first.

### P2: Register Path Lacks Preflight Validation

`Register Path` is disabled until a value is entered, but there is no preview for file existence, readability, detected type, size, or duplicate/collision status before registration.

Recommended fix: add `Validate Path` or live validation with detected metadata and clear next action.

### P2: Accessibility And Keyboard Risks

The LoRA row contains icon-only enabled/delete buttons without text, `aria-label`, or title. Several controls are placeholder-only or unlabeled, including model-library selects and LoRA row inputs. This is especially risky for keyboard-heavy internal tools and screen readers.

Recommended fix: add accessible names to icon-only actions and labels/aria-labels to import controls. Avoid placeholder-only labeling for operational fields.

### P3: Default Technical Fields Should Move To Advanced

Fields like runner JSON, conversion source, LLM encoder, VAE, LoRA apply mode, sampler, CFG, and orientation are valid but overwhelm the happy path. Operators importing a known sdcpp model need fewer decisions.

Recommended fix: split the flow into `Basic`, `Conversion`, `Components`, `LoRA`, and `Advanced` sections, with defaults and inline validation.

## Bottom Line

The implementation now covers the necessary backend and UI primitives, including local `.safetensors` and LoRA import. From an operator perspective, the current page is still closer to an engineering console than a model management workflow. The next product step should not be more raw fields; it should be a dedicated model management flow with import jobs, validation, clear readiness states, and visible dry-run/publish progression.
