# PaperPress Development Instructions

## 1. Product mission

PaperPress is a fast, private and viewer-first PDF workspace.

Documents open directly in The Reading Room, where users can read, navigate, search, compare and review PDFs without unnecessary clutter. Editing, annotation, form filling, signing, OCR, redaction and document intelligence are optional capabilities within the viewer.

PaperPress must remain an excellent PDF viewer even when editing tools, OCR engines, plugins, local agents or AI services are unavailable.

## 2. Core product principles

### 2.1 Viewer first

The viewer is the primary product.

Opening a PDF must place the user directly into a complete reading experience. The user must not need to enter a separate Reader tool or editing environment.

Viewing actions include:

- Opening a document

- Navigating pages

- Scrolling

- Searching

- Selecting and copying text

- Changing zoom

- Using Fit Width or Fit Page

- Changing the viewing layout

- Rotating the view

- Opening thumbnails or the outline

- Entering fullscreen

- Printing without document modification

Viewing actions must never mark the document as modified.

### 2.2 Preserve the original

PaperPress preserves the original document by default.

No feature may silently overwrite, flatten, optimise, repair, redact, sanitise, re-encode or otherwise modify the source PDF.

Potentially destructive operations must:

1. Explain what will change.

2. Explain what will remain unchanged.

3. Identify the destination file.

4. State whether the action is reversible.

5. Produce a new file by default.

6. Verify the resulting file before reporting success.

A failed operation must leave the original intact.

### 2.3 Evidence before confidence

PaperPress must distinguish among:

- Facts directly contained in the document

- Extracted OCR text

- Existing metadata

- User-created annotations

- Automated detections

- AI-generated interpretations

- Unsupported or unavailable information

Automated detections and AI interpretations must not be presented as document facts.

Every intelligent result should navigate back to its supporting evidence where technically possible. Evidence may include:

- Page and passage

- Form field

- Annotation

- Attachment

- Metadata property

- Signature property

- Document comparison result

If supporting evidence cannot be located, PaperPress must say so.

### 2.4 Honest capability reporting

PaperPress must not silently ignore unsupported PDF features.

Unsupported, partially supported or uncertain behaviour must be disclosed clearly. Use status language such as:

- Supported

- Partially supported

- View only

- Unsupported

- Validation unavailable

- Result requires review

Never claim that an operation succeeded merely because it completed without throwing an error.

### 2.5 Local and private by default

Document content must remain on the user’s device unless the user knowingly enables a feature that requires external processing.

Do not send any of the following to a remote service without explicit permission:

- PDF contents

- Extracted text

- OCR text

- Page images

- Thumbnails

- Annotations

- Form values

- Signatures

- Filenames

- File paths

- Document metadata

- Search queries derived from document content

Local-only mode must block remote processing rather than merely displaying a warning.

### 2.6 The user remains in control

PaperPress may recommend actions, identify risks and prepare proposed changes. It must not make irreversible document decisions without deliberate user action.

Examples:

- Detect sensitive information, but do not automatically redact it.

- Identify likely blank pages, but do not automatically delete them.

- Suggest OCR, but do not replace the original automatically.

- Highlight form fields, but do not invent or populate values.

- Identify comparison differences, but do not decide which version is correct.

- Generate a safe-share checklist, but require review before export.

## 3. Interface principles

### 3.1 Default opening state

Unless a saved preference states otherwise:

- Open the document in View mode.

- Use Fit Width.

- Use continuous scrolling.

- Keep the left navigation sidebar closed.

- Keep the right contextual sidebar closed.

- Display the current page and total page count.

- Prioritise the visible page for rendering.

- Do not display an unsaved-change state.

### 3.2 Workspace structure

Use a predictable three-region layout:

- Left: document navigation

- Centre: document content

- Right: contextual tools, properties and assistance

The left sidebar may contain:

- Pages

- Outline

- Bookmarks

- Attachments

- Comments

- Search results

The right sidebar may contain:

- Document information

- Annotation properties

- Form-field properties

- Signature information

- Redaction review

- Document intelligence

### 3.3 Progressive disclosure

Keep the default viewer uncluttered.

The primary toolbar should prioritise:

- Sidebar

- Page navigation

- Zoom

- Fit Width

- Fit Page

- Rotation

- Search

- Print

- Save a Copy

- Additional actions

Mode-specific controls should appear only when their mode is active.

Primary document modes are:

- View

- Annotate

- Fill & Sign

- Redact

- Edit

Only one primary mode may be active at a time.

### 3.4 Clear state communication

The application must visibly distinguish:

- Clean document

- Unsaved changes

- Saving

- Saved

- Save failed

- Recovery available

- Read only

- Locked

- Processing

- Processing failed

Interface state and document state must not be conflated.

For example, opening a sidebar changes interface state but not document state.

### 3.5 Risk-aware interactions

Operations should communicate their risk level through wording, icons and layout. Do not rely on colour alone.

Use these conceptual categories:

- Safe viewing action

- Reversible working change

- Export or conversion

- Irreversible operation

Before an irreversible action, explain:

- What will change

- Whether the original is preserved

- Whether the result can be reversed

- Which file will be created or replaced

- How PaperPress will verify the result

## 4. Architecture guardrails

### 4.1 Separate state domains

Maintain explicit separation between:

- Application state

- Window state

- Tab state

- Document state

- Viewer state

- Persistence state

- Processing state

- Temporary tool state

A document tab should independently maintain:

- File reference

- Current page

- Scroll position

- Zoom value

- Zoom mode

- Viewing layout

- View rotation

- Sidebar state

- Search state

- Modification state

- Undo and redo history

- Recovery state

Do not place all application and document state into one unrestricted global store.

### 4.2 Separate PDF layers

Treat the PDF experience as layered functionality:

1. Page rendering layer

2. Text layer

3. Existing annotation layer

4. Annotation editing layer

5. Form interaction layer

6. Selection and interaction layer

7. Focus and accessibility layer

8. Temporary tool overlay

9. Search-result overlay

A feature must not draw permanently into the rendered page canvas when a separate interaction or annotation layer is appropriate.

All layers must remain aligned after:

- Zoom changes

- Window resizing

- Page rotation

- Layout changes

- Device-pixel-ratio changes

- Fullscreen changes

### 4.3 Central command registry

Toolbar buttons, menus, keyboard shortcuts, context menus and the future command palette must call the same central command definitions.

Commands should expose:

- Identifier

- Label

- Description

- Availability

- Enabled state

- Keyboard shortcut

- Execution handler

- Applicable mode

- Modification effect

- Risk classification

Do not duplicate command behaviour across interface components.

### 4.4 Explicit document capabilities

Determine and store document capabilities when a PDF is opened.

Capabilities may include:

- Searchable text

- OCR recommended

- Existing annotations

- Interactive forms

- XFA form

- Embedded files

- JavaScript actions

- Encryption

- Printing permitted

- Modification permitted

- Existing signatures

- Damaged or partially recoverable structure

Features must check document capability before execution.

Unsupported actions must be disabled or explained. They must not fail silently.

### 4.5 Worker-based processing

Expensive operations should not block the main interface thread.

Use workers or equivalent isolated processing for:

- PDF parsing

- Page rendering where supported

- Text extraction

- OCR

- Document comparison

- Search indexing

- Redaction processing

- Sanitisation

- AI indexing

- Large exports

Workers must support:

- Progress reporting

- Cancellation

- Failure reporting

- Cleanup

- Tab ownership

- Protection against stale results

A cancelled or obsolete task must not update the active document later.

### 4.6 Rendering discipline

Rendering priority should generally be:

1. Visible page or pages

2. Immediately adjacent pages

3. Pages in the current reading direction

4. Remaining thumbnails

5. Background indexing work

Cancel obsolete rendering when:

- Zoom changes

- Layout changes

- View rotation changes

- The user scrolls away

- The active tab changes

- The document closes

Release high-memory page canvases that are sufficiently distant from the viewport while preserving stable page dimensions.

Do not render every page of a large document at full resolution during opening.

### 4.7 Feature isolation

The viewer must continue functioning when any optional subsystem fails.

Optional systems include:

- OCR

- AI agents

- Plugins

- Signature validation

- External applications

- Comparison engines

- Redaction processors

An optional subsystem must not become a required dependency for opening, viewing, navigating, searching ordinary text PDFs or printing.

### 4.8 Feature flags

Incomplete, experimental or high-risk functionality must remain behind an explicit feature flag.

Feature flags must not be used to hide insecure unfinished code in production. Disabled features should not register destructive commands or expose misleading controls.

## 5. Document integrity guardrails

### 5.1 Dirty-state rules

The following must not mark a document as changed:

- Opening

- Closing a clean document

- Scrolling

- Page navigation

- Search

- Text selection

- Copying

- Zoom

- Fit mode

- View rotation

- Layout changes

- Sidebar changes

- Theme changes

- Fullscreen

- Print preview

The following normally mark a document as changed:

- Creating, editing or deleting an annotation

- Changing a form-field value

- Adding a signature appearance

- Changing persisted page rotation

- Editing page content

- Adding or removing pages

- Marking or applying redactions where marks are stored

- Changing document metadata

- Attaching or removing embedded files

Dirty state must be derived from document operations, not from general interface activity.

### 5.2 Transactional saving

Use the safest available write process.

Where supported:

1. Write to a temporary destination.

2. Complete the write.

3. Validate that the result can be reopened.

4. Confirm basic document integrity.

5. Replace or rename the destination atomically.

6. Update the active file reference only after success.

Never clear dirty state before a successful save has been confirmed.

### 5.3 Save semantics

Maintain clear distinctions:

- Save updates the active working file where permitted.

- Save As creates a new working file and changes the active reference.

- Save a Copy creates another file without necessarily changing the active reference.

- Export creates a derived file for a specified purpose.

The interface must tell the user which file remains active after the operation.

### 5.4 Recovery

Unsaved changes should have a recoverable local working state where practical.

Recovery must:

- Remain local

- Avoid overwriting the original

- Be attributable to the correct file

- Avoid storing passwords

- Be removable by the user

- Be cleaned after successful save or deliberate discard

- Never be included in diagnostics

- Respect privacy settings

### 5.5 Unsupported content preservation

When saving a modified PDF, do not silently discard unsupported content.

Before adopting a PDF writing library or save strategy, verify its treatment of:

- Existing annotations

- Forms

- Digital signatures

- Attachments

- Metadata

- Outlines

- Links

- Optional content groups

- JavaScript actions

- Encryption

- Unknown objects

If preservation cannot be guaranteed, disclose the limitation and use an export path that preserves the original.

## 6. Annotation guardrails

- Existing annotations must not create dirty state until changed.

- Annotation coordinates must be stored in document coordinate space.

- Annotation appearance must remain aligned across zoom and rotation.

- Annotation creation must support undo and redo.

- Flattening must be a separate, deliberate export operation.

- Flattening must never occur silently during ordinary save.

- Annotation author information must not be invented.

- Deleted annotations must remain recoverable through undo until the operation history is cleared.

- Annotation summaries must distinguish selected document text from user comments.

## 7. Form guardrails

- Support AcroForms incrementally and report unsupported behaviour.

- Do not claim full form compatibility based only on visible field rendering.

- Detect JavaScript-dependent calculations, formatting or validation where possible.

- Do not report a form as valid if required validation could not be executed.

- Treat XFA as a separate compatibility category.

- Identify XFA documents before users enter substantial data.

- Existing field values must not create dirty state until altered.

- Required-field warnings must be based on declared document properties, not assumptions.

- Save failure must not remove entered values from the active session.

- Do not log form-field values.

## 8. Signature guardrails

A visual signature appearance is not automatically a cryptographic digital signature.

Use precise terminology:

- Signature appearance added

- Digitally signed

- Signature valid

- Signature validity unknown

- Document changed after signing

- Certificate not trusted

- Signature could not be validated

Never use “digitally signed” for a typed, drawn or image-based signature unless a valid certificate-based signing operation occurred.

Do not state that a signature is fraudulent merely because validation is unavailable or a certificate is untrusted.

Never log, export or expose:

- Private keys

- Certificate passwords

- Secret key material

- Unprotected reusable signature assets

## 9. OCR guardrails

- OCR must be optional.

- OCR processing should occur locally by default.

- Preserve the original scan.

- Save OCR output as a new searchable copy by default.

- Identify which pages appear to require OCR.

- Permit page-range and language selection.

- Report failed pages.

- Support cancellation.

- Do not represent OCR text as guaranteed accurate.

- Distinguish native PDF text from OCR-generated text.

- Search and AI features must know the source of extracted text.

- Do not silently replace existing useful text with lower-quality OCR text.

## 10. Redaction guardrails

Redaction is a high-risk, destructive operation.

A black rectangle is not a completed redaction.

Use two distinct stages:

1. Mark for redaction

2. Apply redactions

Before application, all items must be labelled “Marked for redaction.”

Applying redactions must:

- Require deliberate confirmation

- Preserve the original by default

- Write to a new file

- Remove underlying content rather than only cover it

- Address associated OCR text where applicable

- Reopen the output

- Verify the affected regions where technically possible

- Report unsupported or unverified content

Do not state that a file is safely redacted unless verification has completed successfully.

If verification is incomplete, say:

“Redactions were applied, but complete verification was not possible. Review the exported document before distribution.”

## 11. Sanitisation guardrails

Sanitisation may need to review:

- Document metadata

- Comments

- Annotations

- Form values

- OCR text

- Embedded files

- Hidden layers

- Optional content

- JavaScript actions

- Previous revisions

- Other hidden or recoverable content

The application must identify:

- Categories inspected

- Categories removed

- Categories retained

- Categories unsupported

- Verification performed

Do not claim complete sanitisation when any relevant category could not be inspected.

A sanitisation report must not reproduce the sensitive information that was removed.

## 12. AI and document-intelligence guardrails

### 12.1 AI is optional

AI failure must never prevent normal PDF viewing.

Users must be able to open, read, search, navigate and print supported PDFs without an AI agent.

### 12.2 Grounded responses

Document answers should include page references and, where possible, direct navigation to the supporting passage.

The assistant must distinguish:

- Found in document

- Inferred from document

- Generated suggestion

- Not found

- Unable to determine

Do not generate a confident answer when no supporting document passage was located.

### 12.3 Context boundaries

The active document is the default AI scope.

Do not include:

- Other open tabs

- Previous documents

- Recent files

- Other workspaces

- Clipboard history

- Recovery files

unless the user deliberately includes them.

Cross-document questions must identify which documents are included.

### 12.4 Privacy visibility

Before a document question is submitted, the interface should identify whether processing is:

- Local

- External

- Unavailable

A setting named “Never send document content to remote services” must block external document processing when enabled.

### 12.5 No hidden action execution

Natural-language requests must map to known application commands.

Before executing a destructive command, display the interpreted action and require confirmation.

AI must not bypass:

- Permission checks

- Capability checks

- Save safeguards

- Redaction review

- Privacy settings

- Plugin restrictions

## 13. Plugin guardrails

Plugins must use an explicit capability model.

Possible capabilities include:

- Read document metadata

- Read extracted text

- Read rendered page images

- Create annotations

- Create exports

- Write source files

- Access selected files

- Access unrestricted filesystem

- Access network

- Invoke local processes

Grant the minimum capability required.

A plugin with network access or source-file write access must be clearly identified.

Plugins must not receive active document content merely because they are installed.

Plugin failure must not crash the viewer or corrupt the active document.

## 14. Accessibility requirements

Accessibility is part of the Definition of Done.

Every user-facing feature must consider:

- Keyboard operation

- Logical focus order

- Visible focus indication

- Accessible names

- Selected and expanded states

- Screen-reader announcements

- High-contrast compatibility

- Reduced-motion preference

- Interface zoom

- Touch target size

- Error identification

- Focus restoration

- Operation without colour alone

Critical workflows must be usable without a mouse.

Automated accessibility testing is required, but it does not replace manual keyboard and screen-reader testing.

## 15. Performance requirements

Do not claim performance improvement without measurement.

Measure relevant behaviour before and after performance changes.

Key measurements may include:

- Time to first visible page

- Time to interactive

- Page rendering latency

- Zoom rendering latency

- Search indexing progress

- Rapid-scroll responsiveness

- Peak memory

- Memory after tab closure

- Memory after canvas release

- Behaviour with multiple open tabs

- Cancellation of obsolete work

Optimise the visible user experience before background completeness.

Do not trade document correctness or integrity for minor speed improvements without explicit product approval.

## 16. Security requirements

Treat PDFs as untrusted input.

Do not assume that a parsed PDF is safe because it opens successfully.

Requirements:

- Validate external links before opening.

- Do not execute embedded PDF JavaScript by default.

- Isolate parsing and processing where practical.

- Limit worker and plugin privileges.

- Avoid unrestricted shell execution from document content.

- Never construct shell commands directly from PDF text.

- Sanitize filenames used in temporary paths.

- Prevent path traversal.

- Avoid rendering untrusted document HTML outside a controlled layer.

- Do not expose local filesystem paths to remote services.

- Keep dependencies current and reviewed.

- Do not commit secrets, keys, passwords or client data.

## 17. Logging and diagnostics

Logs must be useful without exposing document content.

Do not log:

- Extracted document text

- OCR text

- Search terms containing client information

- Form values

- Annotation comments

- Passwords

- Signature images

- Private keys

- Certificate secrets

- Complete filenames or paths unless diagnostics explicitly require them

- Raw document buffers

Prefer:

- Event identifiers

- Component names

- Error categories

- Sanitised stack traces

- Page indexes

- Render durations

- Memory measurements

- Feature availability

- Correlation identifiers

Diagnostic exports must provide an option to remove filenames and paths.

## 18. Testing requirements

Do not test only with simple generated PDFs.

Use a representative synthetic PDF fixture corpus containing:

- Ordinary text PDFs

- Image-only PDFs

- Mixed scanned and text pages

- Large documents

- Mixed page sizes

- Mixed orientations

- Password-protected PDFs

- Corrupt PDFs

- Existing annotations

- AcroForms

- XFA examples

- Embedded files

- JavaScript-dependent forms

- Digital signatures

- Unusual fonts

- Right-to-left text

- CJK text

- Deep outlines

- Links and attachments

Never add real client documents to the repository or permanent test corpus.

For relevant features, test:

- Normal operation

- Empty state

- Loading state

- Cancellation

- Failure

- Retry

- Unsupported content

- Read-only documents

- Save failure

- Tab switching

- Document closing

- Zoom

- Rotation

- Layout changes

- Keyboard operation

- High contrast

- Large documents

## 19. Coding expectations

### 19.1 Before implementation

Before making a substantial change:

1. Read the relevant code.

2. Identify the owning component or service.

3. Identify affected state domains.

4. Identify document-integrity implications.

5. Identify privacy implications.

6. Identify accessibility implications.

7. Identify relevant PDF fixtures.

8. Propose the smallest coherent implementation.

9. State important assumptions.

10. Identify known unsupported behaviour.

Do not begin a broad refactor merely because the current structure is unfamiliar.

### 19.2 During implementation

- Prefer small, reviewable changes.

- Preserve existing behaviour unless the backlog item changes it.

- Use existing application commands and state abstractions.

- Avoid duplicated PDF-processing logic.

- Keep business rules out of presentation components.

- Keep PDF library details behind defined adapters where practical.

- Add cancellation and cleanup for asynchronous work.

- Prevent stale operations from updating closed or inactive documents.

- Use clear error types rather than matching arbitrary error strings.

- Add comments for non-obvious PDF coordinate, rotation and persistence behaviour.

- Do not leave high-risk functionality as an unlabelled placeholder.

### 19.3 After implementation

Before reporting completion:

1. Run relevant tests.

2. Test with representative fixtures.

3. Check keyboard operation.

4. Check accessibility.

5. Check save and failure behaviour.

6. Check tab isolation.

7. Check zoom and rotation alignment.

8. Check cancellation and cleanup.

9. Check privacy and logging.

10. Document limitations.

11. Provide a concise change summary.

12. Identify any unverified behaviour.

Do not say “complete,” “fixed” or “safe” if required verification did not run.

## 20. Change discipline

Do not combine unrelated changes.

Avoid mixing:

- Major refactors with new features

- Formatting changes with behavioural changes

- Dependency upgrades with unrelated interface work

- PDF writing changes with toolbar redesign

- Security-sensitive changes with broad cleanup

If architecture must change first, separate the enabling refactor from the user-facing feature where practical.

## 21. Dependency discipline

Before introducing or replacing a dependency, document:

- Purpose

- Licence

- Maintenance status

- Bundle-size effect

- Runtime effect

- Browser or desktop compatibility

- Worker compatibility

- Security implications

- Data-processing location

- PDF features preserved

- PDF features potentially discarded

- Available alternatives

- Exit strategy

A library being able to render a PDF does not prove that it can safely modify and save one.

## 22. Error-message standard

Error messages should explain:

1. What happened

2. What remains safe

3. What the user can do next

Prefer:

“PaperPress could not save the annotated copy. The original file was not changed. Choose another location and try again.”

Avoid:

“Unknown error.”

Do not expose internal stack traces, secrets or document content in user-facing errors.

## 23. Completion language

Use precise language in implementation summaries.

Preferred:

- Implemented and tested against the listed fixtures

- Implemented behind a feature flag

- Partially implemented

- Rendering completed, but save compatibility remains unverified

- Redactions applied and verification passed

- Redactions applied, but verification was incomplete

- Unsupported for this document type

Avoid:

- Fully supported

- Secure

- Safe

- Guaranteed

- Perfect

- Production ready

unless the applicable evidence and release gates support that statement.

## 24. Definition of Done

A feature is not done until applicable requirements are satisfied:

- Acceptance criteria are met.

- Unit tests pass.

- Integration tests pass.

- Relevant PDF fixtures pass.

- Loading, empty, error and cancellation states exist.

- Keyboard operation is tested.

- Accessibility is reviewed.

- Zoom and rotation are tested.

- Multiple tabs are tested where relevant.

- Save failure is tested where relevant.

- The original document remains recoverable.

- Sensitive content is absent from logs.

- Asynchronous work is cleaned up.

- Unsupported behaviour is disclosed.

- Documentation is updated.

- Known limitations are recorded.

- The resulting behaviour has been verified, not merely executed.

## 25. Product north star

When making a trade-off, prefer the choice that best preserves:

1. Document integrity

2. User privacy

3. Viewer reliability

4. Honest capability reporting

5. Accessibility

6. Performance

7. Interface simplicity

8. Feature breadth

PaperPress should not attempt to win by having the most tools.

PaperPress should win by being the PDF workspace users trust with important documents.
