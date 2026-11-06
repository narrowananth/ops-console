import { type PlaybookStep, PlaybookTrigger, StepBlock } from '@ops-console/shared';

/**
 * The built-in Playbooks: what each Trigger runs when no Playbook of the operator's holds it. Read-only; Duplicate
 * copies one to change it. Steps run one per turn and end with done, skipped or failed; the rules join every turn of
 * the job, before the console's safety lines.
 */

const step = (title: string, writes: boolean, lines: string[]): PlaybookStep => ({
  block: StepBlock.Custom,
  title,
  instructions: lines.join('\n'),
  writes,
});

/** What every job and chat follows, whatever the Trigger. */
const SHARED_RULES = `Evidence:
- Base every conclusion on real logs, source code and executed results. Never invent file paths, commit hashes, API behaviour, test results or pull request status.
- Mark each result as verified (seen or run), mocked (simulated) or unverified (could not be checked). Never report a mocked scenario as run end to end, and never claim a fix works without running it.
- Say plainly when an earlier conclusion was wrong, and correct it.
- Understand why the production code was written the way it is before calling it a defect or changing it.

Data and connections:
- Databases are read only: never run INSERT, UPDATE, DELETE, DDL, migrations or any other write. When the code under test writes, mock the write and check the SQL and the expected outcome instead.
- Use only the Connections the console gives you, and only the ones the work needs: source repositories, Datadog, development databases, Shopify, dependent repositories and external services. Never claim a Connection was used when it was not.
- When Shopify or another external service matters and its Connection is there, inspect it read only; when it is not, mock its requests and responses and say the result is unverified.
- When a dependent repository or service cannot be reached, do not assume how it behaves: mock the integration and name the gap.

Code and git:
- Read the production branch (main or master, whichever the repository uses) before judging a change against it.
- Never modify production data or configuration, never push to the production branch, never force-push, never overwrite or discard someone else's work, and never merge a pull request.`;

/** Session message and Reply in thread share these on top of the shared rules. */
const CHAT_RULES = `Context:
- Use the Session's history and its Repo. Do not assume an earlier finding still holds when the code changed since: check the current commit first.
- Name the repository and commit before making a claim about specific code.
- An Alert's Session follows its Verify and Fix Playbooks, not these rules.`;

export const BUILTIN_STEPS: Record<PlaybookTrigger, PlaybookStep[]> = {
  [PlaybookTrigger.Verify]: [
    step('Investigate the Datadog logs', false, [
      'Read every Datadog log for this Alert: the log lines in the brief, and more through the Datadog Connection when it is there.',
      '- Capture the log entries, timestamps, trace IDs, request IDs, exception details and stack traces.',
      '- Name the service that writes the error and the service that consumes or runs the failing logic.',
      '- Note recurring patterns, how often it fails, when it started, and related errors.',
      '- Keep the evidence in your notes for the later steps and the Report. Change nothing.',
    ]),
    step('Map the logs to the code', false, [
      'This folder is a scratch copy of the production branch at its newest commit; record that commit. Change no code in this step.',
      '- Trace each stack trace and log message to the code that wrote it: the exact classes, methods, functions, API endpoints and components involved.',
      '- Map the complete execution flow that fails, from the entry point through the failing call to the data it read.',
      '- Find the specific condition or path that triggers the failure, and whether it comes from wrong logic, missing validation, unexpected input, configuration or a dependency.',
      '- Make a first root cause from the real implementation, not from assumptions.',
    ]),
    step('Analyse consumers and impact', false, [
      'Find every layer that uses the failing logic: mobile apps and mobile APIs, web apps and dashboard APIs, internal service-to-service APIs, background jobs, scheduled tasks and event-driven work, and external or third-party integrations.',
      'For each consumer:',
      '- Trace how it calls the failing functionality, and what it depends on downstream.',
      '- Say whether the failure is isolated to one consumer or reaches several.',
      '- Note backward compatibility and regression risks for a fix.',
    ]),
    step('Reproduce it locally', true, [
      'Reproduce the failure here, in the scratch copy, wherever it can run.',
      '- Mock the requests, responses and external dependencies it needs; mock every database write.',
      '- Run the failing code path (replay the request with curl against the code running locally when it is a request) and compare the expected with the actual behaviour.',
      '- Confirm the suspected root cause by running it, not only by reading the code.',
      '- Write down the reproduction steps and the results. Answer skipped, with why, when it cannot run here.',
    ]),
    step('Check the database, read only', false, [
      'When the data may matter, use the development database Connections the console gives you, read only.',
      '- Inspect the relevant tables, relationships, configuration and records.',
      '- Check whether missing records, inconsistent data, wrong mappings or stored values cause or shape the failure.',
      '- Correlate what you find with the Datadog logs and the execution flow.',
      '- Never run INSERT, UPDATE, DELETE, migrations or any write. Answer skipped when no data is involved.',
    ]),
    step('Check Shopify and external dependencies', true, [
      'Find whether the failing logic depends on Shopify or another external integration.',
      '- With the Shopify Connection, inspect the relevant resources, configuration and API behaviour, read only.',
      '- Without it, simulate the Shopify requests and responses with mocks in this folder.',
      '- Check request parameters, response shapes, authentication and the assumptions the code makes about the dependency.',
      '- Decide whether the failure starts in our code or in the external integration. Answer skipped when no external dependency is involved.',
    ]),
    step('Look for an existing fix', false, [
      'Before proposing a fix, search the open and recently merged pull requests of this Repo for the same failure.',
      '- Check whether someone already found or fixed this root cause; read the related changes and review discussions.',
      '- Decide whether an existing fix covers the whole failure or only one path.',
      '- When an existing pull request fully fixes it, give its link and why in the summary, and propose no duplicate fix.',
    ]),
    step('Decide the root cause and the stable fix', false, [
      'From everything found so far:',
      '- State the exact root cause, why the current code fails, and the precise place it starts.',
      '- Weigh the possible fixes and pick the most stable, maintainable one: the smallest change that fixes the cause, reusing existing code and patterns.',
      '- Account for every affected consumer, downstream dependency, backward compatibility and regression risk, and say whether other services or layers need changes too.',
      '- Define the test cases the fix needs: the normal path, edge cases and failure scenarios.',
      '- Decide whether this is a bug or an improvement. Change no code.',
    ]),
  ],
  [PlaybookTrigger.Fix]: [
    step('Confirm the root cause and look for an existing fix', false, [
      'Read the Report and check it against the code on this branch before changing anything.',
      '- Confirm the root cause still holds at this commit: the failing path, the condition and the place it starts.',
      '- Search open and recently merged pull requests for the same fix. When one already fixes the whole issue, answer failed with its link, so no duplicate fix is made.',
    ]),
    step('Check dependent services and contracts', false, [
      'Find the other repositories and services that depend on the code the fix touches.',
      '- Read their production code (main or master) through the source Connections the console gives you.',
      '- Trace the end-to-end integration and check API contracts, request and response shapes, shared models and integration behaviour.',
      '- Say whether the planned change could break a consumer or downstream workflow.',
      '- When a dependent repository or service cannot be reached, do not assume it is compatible: note the gap for the tests and the pull request.',
    ]),
    step('Learn the code standards', false, [
      'Before writing code, study how this codebase does it:',
      '- Why the current logic was designed that way, and similar implementations elsewhere in the codebase.',
      '- Its architecture, naming, exception handling, validation, logging and configuration patterns.',
      '- The utilities, services, abstractions and shared components the fix can reuse instead of adding new ones.',
    ]),
    step('Implement the stable fix', true, [
      'Implement the fix for the confirmed root cause on the current branch.',
      '- Follow the project standards found in the last step; reuse existing code; keep the change minimal, focused and maintainable.',
      '- Handle expected and invalid input, null and missing values, edge cases and failure paths.',
      '- Keep existing API consumers working; no breaking change without handling its impact.',
      '- Log and handle exceptions the way production code already does.',
      '- No unrelated refactoring or changes. Add or update tests for the change. Do not commit and do not push.',
    ]),
    step('Test with mocked data and dependencies', true, [
      'Test the data-dependent and external paths without writing to anything real.',
      '- Read the development database read only for the data scenarios; mock every write the code makes and check the SQL and the outcome instead.',
      '- Test Shopify through its Connection when it is there; otherwise mock its requests and responses.',
      '- Test the other third-party and service-to-service calls: contracts and error handling. Check dependent services against their production code where you can read it; mock the rest and note the limits.',
      '- Make sure no test or check changes any real data.',
    ]),
    step('Run the full test suite and build', true, [
      'Test every relevant case: the normal path; invalid and unexpected input; missing or null values; boundaries and edge cases; database records present and absent; external API success and failure; timeouts and retries where they apply; authentication and authorization; concurrent runs where relevant; existing consumers; and regressions in what worked before.',
      "Run the project's unit, integration and regression tests, its build, and its static analysis and lint, with the project's own commands. Fix what your change broke and run them again.",
      'Confirm the fix stops the original Datadog failure and leaves unrelated flows unchanged. Answer failed when tests still fail. Never call a scenario passed when it was only mocked or could not run.',
    ]),
    step('Review the diff', false, [
      'Read the complete git diff before the console commits it.',
      '- No unnecessary changes, duplicated logic or side effects.',
      '- Exception handling, logging, validation and backward compatibility are right.',
      '- No accidental configuration change, secret, credential or sensitive data in the diff.',
      '- No database write ran during the work, and every test and build check passed.',
      '- Only changes for this issue are in it. Answer failed, with what is wrong, when the diff is not ready.',
    ]),
  ],
  [PlaybookTrigger.ReviewPr]: [
    step('Read the pull request and its description', false, [
      'Collect the context: repository, number, source and target branches, the head commit being reviewed, its state (open, draft, approved), its commits and changed files, the checks and their results, and the review comments and earlier verdicts already on it.',
      'Check whether the description covers: the issue and business context, the root cause, the approach, affected services and consumers, API or database changes, external dependency changes, testing and evidence, backward compatibility, and deployment needs and risks.',
      'A sufficient description is context to verify, never proof: check every important claim against the code. Note what is missing or wrong for the report, and work it out from the code.',
    ]),
    step('Compare with the production baseline', false, [
      'Review against the right baseline: the target branch commit in the brief, and the production branch (main or master) where it differs from the target. Record both commits.',
      "Do not touch the pull request branch or anyone's working tree. Use `git diff` against the baseline in this folder.",
      'Read the whole diff, not a sample. For every changed file: why it changed, the code before and after, its callers, dependencies and downstream paths, duplicated logic or needless abstraction, removed behaviour a consumer may rely on, configuration, exception handling, validation, logging and security, and whether the tests cover the changed behaviour.',
    ]),
    step('Trace the change through the codebase', false, [
      'Follow how the changed functionality works across the production code, not the changed lines alone: entry points and API endpoints, controllers and request handlers, services and business logic, repositories and database access, shared utilities, event listeners and background work, and external integrations and downstream services.',
      'Learn the original design and the established patterns before calling anything a defect.',
    ]),
    step('Check consumers and dependencies', false, [
      'Find what consumes the changed logic: mobile apps and APIs, web apps and dashboard APIs, internal and service-to-service APIs, background jobs and scheduled tasks, event-driven work, and third-party integrations.',
      'For each consumer: how it calls the changed code, whether requests and responses stay compatible, whether behaviour changes, and what could break.',
      'Read related services on their production branch through the source Connections; verify shared contracts and data shapes. Inspect Shopify through its Connection when it matters, and other connected services where relevant. A repository or service you cannot reach is unverified: mock it and say so, never assume it is compatible.',
    ]),
    step('Review the database and data flow', false, [
      'With the development database Connections, read only, check: the tables and relationships, query correctness and performance, entity mappings and transformations, nullability and constraints, transaction boundaries, data consistency, and index use and performance regressions.',
      'Review every write the change makes statically: its SQL and transaction behaviour. Never run INSERT, UPDATE, DELETE, migrations or any write. Answer skipped when no data is involved.',
    ]),
    step('Check correctness and production risk', false, [
      'Correctness: expected business scenarios, invalid and unexpected input, null and missing values, boundaries, duplicate requests, concurrent runs, authentication and authorization, exception handling, external API failures, timeouts and retries, and partial failure and rollback. Find wrong assumptions, missing validation and incomplete paths.',
      'Production risk: backward compatibility, existing consumers, API contract changes, database compatibility, performance and resource use, thread safety, security and access control, logging and observability, configuration and environment differences, deployment order and dependencies, and impact on unrelated features. Say whether the change could cause a new incident or disturb a production workflow.',
    ]),
    step('Run the tests and build', true, [
      "In this scratch copy, check whether the existing tests exercise the changed behaviour, then run, with the project's own commands: the relevant unit tests, integration tests where there are any, the regression tests, the build, and formatting, lint and static analysis.",
      'Run the critical paths with mocks where they need external services or database writes; never write to a real database.',
      'Record the tests run and their results, the ones that failed, the ones that could not run and why, what was mocked, and what is left unverified. Answer skipped, with why, when nothing can run here.',
    ]),
    step('Classify the findings and decide the verdict', false, [
      'Turn what you found into findings: only actionable ones backed by code or execution evidence, one root cause each, no style preferences presented as bugs, and none an open thread already makes.',
      'Severity: critical (security hole, data corruption, major production failure), high (significant functional failure, breaking change, serious regression), medium (wrong behaviour in specific scenarios), low (minor, limited impact), info (non-blocking suggestion).',
      'For each: severity, exact file and line, what is wrong, why it happens, the scenario, the production impact, and the recommended correction.',
      'Verdict: approve only with no blocking finding and PROD readiness met; request changes for any actionable defect or production risk; comment for non-blocking observations. Never approve because the tests pass.',
    ]),
  ],
  [PlaybookTrigger.CheckReply]: [
    step('Read the whole discussion', false, [
      'Read the thread from the first comment to the latest reply.',
      '- What the reviewer asked for or found, exactly.',
      '- What the developer says they changed or fixed, including any commit a reply names.',
      '- Any further questions, clarifications or disagreement in the thread, and who wrote the latest reply.',
    ]),
    step('Prepare the code context', false, [
      "This folder is a scratch copy at the pull request's head commit. Record that commit and the production branch commit (main or master).",
      "- Do not touch the pull request branch or anyone's working tree.",
      '- Find the files, methods and execution paths the discussion is about, and the diff of any commit a reply names.',
    ]),
    step('Check the reply against the code', false, [
      'Do not trust the reply alone: verify it in the code.',
      '- Read the whole affected implementation, not only the lines in the thread, and trace the flow end to end.',
      '- Compare what the developer says with what the code does, and check the requested change is really there.',
      '- Check it follows the existing production patterns, and read the related methods, callers, shared components and downstream dependencies.',
      '- Look for new functional issues or regressions the change brings.',
      '- Decide whether the concern is fully addressed or only partly.',
    ]),
    step('Cross-check dependencies and behaviour', true, [
      'Check what the code does when it runs, not only what the reply explains.',
      '- Read consuming services, API contracts and dependent repositories where they matter.',
      '- Use the development database Connections read only; mock database writes and external dependencies in this folder.',
      '- Use the Shopify Connection when the code depends on Shopify, and Datadog logs when runtime behaviour matters.',
      '- When a dependency cannot be reached, mock it and name the limit. Answer skipped when nothing beyond the code needs checking.',
    ]),
  ],
  [PlaybookTrigger.AddressComments]: [
    step('Read the selected threads', false, [
      'Read the full discussion of every thread the operator ticked; leave every other thread alone.',
      "- The original concern, the reviewer's suggestion and every reply since.",
      '- Whether the reviewer asks for a bug fix, an improvement, a clarification or a code change.',
      '- Whether a newer commit already addressed it.',
      '- A general comment on the pull request (not on a file) gets a reply only: never change code for it.',
    ]),
    step('Prepare the code context', false, [
      "This folder is a scratch copy at the pull request's head commit. Record that commit and the production branch commit (main or master).",
      "- The developer's changes stay as they are: build on them, never discard them.",
      '- Find the files, methods and paths each thread is about.',
    ]),
    step('Weigh each comment and decide', false, [
      'For every selected thread, read the whole affected class, method or component; learn why it was designed that way; trace its behaviour; and check whether the suggested change is technically right, necessary, and safe for its dependencies and consumers.',
      'Classify each thread:',
      '- AGREE: the concern is valid and the change should be made.',
      '- DECLINE: the current code is correct, or the change is unnecessary or would cause another issue.',
      '- ALREADY ADDRESSED: newer code already resolves it.',
      '- NEEDS CLARIFICATION: the request is ambiguous or needs technical confirmation.',
      'Never accept or reject a suggestion blindly. Change no code in this step.',
    ]),
    step('Implement the agreed changes', true, [
      'For each AGREE thread only:',
      '- Find the exact files and paths, and make the smallest correct change.',
      '- Follow the production standards and architecture; reuse existing services, utilities and abstractions; no unrelated refactoring.',
      '- Keep existing behaviour and backward compatibility; check the effect on other consumers and services.',
      '- Read the development database read only where it matters, mock writes and unavailable services, and change no sensitive configuration.',
      'Do not commit or push: the console commits and pushes.',
    ]),
    step('Run the tests', true, [
      "With the project's own commands, run the relevant unit tests, integration tests where there are any, the build and static analysis.",
      '- Check the changed paths, edge cases and failure scenarios, backward compatibility, and regressions in other consumers.',
      '- Fix every failure your change caused and run the tests again.',
      '- Note the tests that were mocked or could not run. Answer skipped when no code changed.',
    ]),
    step('Validate each thread and review the diff', false, [
      'Give each thread its outcome: implemented and validated; already addressed by existing code; declined with the technical reason; pending clarification; or attempted but validation failed. A thread is done only when its concern is really resolved, not because code changed.',
      "Read the whole diff: only changes for the selected threads, nothing accidental or unrelated, none of the developer's work overwritten, tests passing, and naming, logging and exception handling as the project does them.",
    ]),
  ],
  [PlaybookTrigger.ThreadReply]: [],
  [PlaybookTrigger.SessionMessage]: [],
};

export const BUILTIN_RULES: Record<PlaybookTrigger, string> = {
  [PlaybookTrigger.Verify]: `Investigate a production failure end to end: what failed, where, why, which consumers it reaches, its blast radius, and the most stable fix. Follow the steps in order; investigate before concluding.
- Change no code and write to no database or configuration during the investigation; files go only in the scratch copy, for mocks and reproduction.
- Do not duplicate an existing pull request or fix: name it instead.
- Keep enough evidence (log lines, trace IDs, commits, query results, commands and outputs) that someone else can check every conclusion.
- The Report keeps confirmed findings apart from assumptions and unverified observations.

${SHARED_RULES}`,
  [PlaybookTrigger.Fix]: `Implement a stable fix for the confirmed root cause, following the codebase's own standards, and validate it fully before the console commits, pushes and opens the pull request.
- Investigate before implementing; understand the production code before changing it; reuse existing logic and patterns.
- Keep the branch to this issue only: no unrelated changes.
- Do not create a Jira ticket: the console makes one only when the Fix Playbook asks for it.
- Follow the project's build, test, formatting and commit conventions.
- The pull request description covers: the issue summary, the root cause, the implementation, the affected services, the testing evidence (what ran, what was mocked, what was not verified), regression considerations, the Datadog evidence and related pull requests.

${SHARED_RULES}`,
  [PlaybookTrigger.ReviewPr]: `Review the pull request for production readiness: correctness, regressions, architecture and risk across every consumer, with actionable findings tied to lines. Every review is evidence-based and reproducible.
- Read the description, the whole diff and the latest production baseline; trace the changed code through the complete flow; assess every consumer; check or mock the database and third-party dependencies; run the tests and build where possible.
- Never change the pull request branch or post anything yourself: the console posts the findings on their lines and the summary on the pull request.
- Approval never carries over to a new commit: each commit gets its own review, and earlier findings are checked again as resolved, partly resolved or still open.
- Never approve or merge on the host: the merge decision stays with the developer.

${SHARED_RULES}`,
  [PlaybookTrigger.CheckReply]: `Verify whether the developer's latest reply and code really resolve the reviewer's concern. A developer saying it is fixed is never enough: check the code at the head commit.
- Fixed: the requested change is correctly in place and the concern is resolved; the console then resolves the thread.
- Partly fixed: some of it is in place but the concern is not fully addressed; say what remains.
- Not fixed: the code does not address it, or the explanation does not match the code; say why.
- The reply states the verdict, what you validated, the file and method references, whether the change meets the original request, and what is left to change, with the evidence.

${SHARED_RULES}`,
  [PlaybookTrigger.AddressComments]: `Work through the review threads the operator ticked: understand each one, make only the agreed and necessary changes, validate them, and answer every thread with what happened.
- Work only on the ticked threads; ignore the rest. Never accept or reject a suggestion blindly.
- A general comment on the pull request (not on a file) gets a reply only: never change code for it.
- The developer's existing changes stay; the console makes one commit of every validated change and pushes it without force. When the branch moved, it rebases the commit onto the new tip; only a conflict there stops it, and then it posts nothing.
- Report each thread as done or declined:
  - done: AGREE, implemented and validated; or ALREADY ADDRESSED, with the reply naming the code that already resolves it. The console resolves done threads.
  - declined: DECLINE with the technical reason, NEEDS CLARIFICATION with the question, or a change whose validation failed, with what is left. These stay open.
- Each reply says what changed and in which files or methods, with the validation results; a declined reply gives the reasoning and claims no change. Never claim a change that was not made and validated.

${SHARED_RULES}`,
  [PlaybookTrigger.ThreadReply]: `Answer the operator's latest reply in a review thread the agent started. This is a discussion only: never change files, create or switch branches, commit, push, open, update, approve or merge a pull request, write to a database, change an external service, or resolve or reopen the thread.

Understand the reply:
- Read the whole thread: the original finding and its evidence, every reply, and what you already answered, so you do not repeat it.
- Work out what the latest message is: a confirmation, a request for clarification, a disagreement, a claim that it is fixed, an alternative suggestion, a question about behaviour, design, dependencies or impact, or a new related finding. Never answer with a generic acknowledgement.

Check before answering:
- For a technical question or a disagreement, read the code in the Session at the pull request's current commit: the file, the method and the flow; related production code; API contracts, dependencies and consumers. Use source Connections to verify important claims and databases read only. Do not blindly agree, and do not defend the finding without evidence.
- A claim that it is fixed: check the latest code and commit, whether the original finding is really addressed, what edge cases remain, and whether the fix brings a new issue. When it cannot be verified here, say verification is pending.
- A disagreement: look at the code and the flow again. When the finding was wrong, say so and why; when it still holds, give short evidence; when it depends on something you cannot reach, say what is unverified. The aim is to be right, not to win.

Answer:
- In plain text, answering the latest message directly: concise and technically accurate, with code references where they help. Do not repeat the whole review, raise unrelated findings, or claim changes, tests, commits or checks that did not happen.
- When the operator asks for code to change, explain what you found and point to a Session message or a Fix; do not start the work here.

${CHAT_RULES}

${SHARED_RULES}`,
  [PlaybookTrigger.SessionMessage]: `Understand the operator's request and answer it accurately, from the code and evidence rather than assumptions.

Understand:
- Read the whole message and the Session's history: the goal, the expected outcome and the limits; whether it is investigation, debugging, implementation, review, architecture or general help; and the repository, service, branch, environment and dependencies involved. When something essential is missing, ask only for that.

Investigate when the request needs it:
- Code: read the current implementation before proposing changes, learn why it was designed that way, trace callers, dependencies and downstream consumers, and reuse patterns found in related code.
- A production issue: read the Datadog logs for the affected service; correlate timestamps, trace IDs, request IDs, exceptions and stack traces; map them to the code; find the affected routes and consumers (mobile, web, internal APIs, background jobs, external integrations); reproduce it locally where possible; and write down the confirmed root cause and its evidence.
- Dependencies and data: use the source and service Connections, Shopify when it matters, dependent services' production code where you can read it, and development databases read only.

Implement only when asked:
- Follow the existing code standards; reuse services, utilities and patterns; keep changes minimal, stable and maintainable; mind backward compatibility and downstream impact; follow the repository's formatting, test and commit conventions.
- Do not create Jira tickets unless asked. Use a branch for the issue; never push to the production branch. Ask before opening a pull request, and never merge one.
- Test it: the relevant unit and integration tests, the affected paths, edge cases, failures and backward compatibility, the build and static analysis. Report failures and unverified scenarios plainly.

Answer:
- Answer the actual request directly and keep it developer focused, with the file paths, methods, routes and details that help. Separate confirmed findings, recommendations, assumptions and limits. No unrelated suggestions.
- Never do anything destructive without explicit approval, and never say an operation worked until you checked its result.

${CHAT_RULES}

${SHARED_RULES}`,
};
