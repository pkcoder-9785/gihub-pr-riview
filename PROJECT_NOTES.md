# GitHub PR Review Bot — Project Notes

Last updated: 22 November 2026 (Asia/Kolkata)

## Current delivery status

Corrected Plan v4 ka application-code scope implement ho chuka hai: secure/current-state webhook intake, bounded and redacted review context, evidence-validated AI output, atomic token budgets, snapshot-safe GitHub publishing, ambiguous-write reconciliation, installation-wide pacing aur scheduled publication recovery. Latest verification `npm test` mein 35/35 tests pass aur changed JavaScript files ke syntax checks pass hain. Inngest registration aur dependency-tree checks bhi pass hue.

Real PostgreSQL, GitHub App, OpenAI aur Inngest deployment credentials/services ke saath live end-to-end run ya selected-repository pilot nahi hua. Isliye production rollout aur quality/notification verification abhi pending hain; local checks ko live integration ka substitute na samjho.

## Is document ka purpose

Ye project ka main design aur handoff document hai. Nayi session mein ise padho, phir implementation status ko actual source files se verify karo. Corrected Plan (v4) product requirements ka latest reference hai; neeche us design ko current code ke status se alag rakha gaya hai.

- User project ko incremental, aam taur par ek file/step per request, implement karna chahta hai.
- Explanation Roman Hindi/Hinglish mein; code JavaScript ES modules mein.
- Requested code ke bahar refactor ya scaffolding mat karo.
- Har project change, design decision, actual check/result, encountered problem, uska cause/fix, blocker aur next step isi `PROJECT_NOTES.md` mein record karo. Naya project-related handoff/update kisi doosri Markdown file mein mat banao jab tak user specifically na kahe.
- Koi problem aaye to pehle is document ke design contracts, safety rules aur invariants follow karke diagnose/fix karo. Fix existing contract se takraye ya missing decision par depend kare to code ko guess se badalne ke bajay pehle concern/decision yahin record karo aur zaroori clarification lo.
- `.env`, tokens, private keys, real webhook payloads ya private source code ko read, print, copy ya document mat karo.
- Source code actual implementation ka authority hai. Plan ko implemented feature tabhi bolo jab code mein ho aur verification result actual command se mila ho.

## Product goal aur scope

Selected GitHub App repositories ke non-draft pull requests par advisory AI review dena. Review mein author ke changes ka summary, maximum paanch evidence-supported findings, reviewed commit aur coverage report ho. Configured owner ko same review body mein mention kiya ja sakta hai.

Bot sirf review karega. Ye code execute/edit, PR approve, block ya merge nahi karega. Fork ka code kabhi execute nahi hoga. V1 mein dashboard, billing aur manual review commands nahi hain. Initial quality evaluation JavaScript/TypeScript repositories par hogi; App permissions selected repositories tak limited rahengi.

## Stack aur system boundaries

- Node.js JavaScript ES modules, Express HTTP server.
- GitHub App installation authentication aur API calls: Octokit + `@octokit/auth-app`.
- Durable webhook processing, debounce, concurrency aur retry: Inngest.
- Review: OpenAI Responses API, strict structured output, `store: false`.
- Validation: Zod. Diff/anchor utilities: `diff` dependency; current anchor parser custom/simple hai.
- Durable budgets/publication state: current code PostgreSQL (`pg`) use karta hai. Deployment target ke hisaab se storage choice confirm hogi, lekin atomic budget accounting aur durable publication state mandatory hain.
- Automated verification: `node:test` + Supertest.

`package.json` mein `test` script `node --test` hai. Dependency declarations actual manifest se check karo; purane notes ka dependency status stale ho sakta hai.

## Environment aur local commands

`config.js` Zod se env validate karta hai. `.env.example` mein placeholders hain; usse local `.env` banate waqt asli values ko kabhi commit/document mat karo.

| Variable | Current rule/default |
| --- | --- |
| `NODE_ENV` | `development`; `test` aur `production` bhi valid |
| `PORT` | `3000`; integer `1..65535` |
| `GITHUB_APP_ID` | Required positive numeric string |
| `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Required; private key escaped `\n` ko newline mein badla jata hai |
| `GITHUB_REPOSITORY_ALLOWLIST` | Required comma-separated `owner/repo` list |
| `DATABASE_URL` | Required PostgreSQL URL |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Required; model hardcode nahi |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | Production mein required; development mein optional |
| `REVIEW_OWNER` | Optional GitHub username, `@` ke bina |
| `REVIEW_MAX_FILES` | `30` |
| `REVIEW_MAX_INPUT_CHARS` | `80000` |
| `REVIEW_MAX_INPUT_TOKENS` | `24000` |
| `REVIEW_MAX_OUTPUT_TOKENS` | `4000` |
| `REVIEW_MAX_FINDINGS` | `5`, maximum `5` |
| `REVIEW_GLOBAL_CONCURRENCY` | `5` |
| `REVIEW_DAILY_TOKEN_LIMIT` | `100000` per repository |
| `REVIEW_GLOBAL_DAILY_TOKEN_LIMIT` | `500000` global |
| `REVIEW_PR_DAILY_TOKEN_LIMIT` | `50000` per installation/repository/PR key |
| `GITHUB_BOT_AUTHOR_ALLOWLIST` | Optional comma-separated bot logins; by default GitHub Bot authors are skipped |
| `REVIEW_KILL_SWITCH` | `false`; `true`/`false` only |

Tokenizer `js-tiktoken` configured OpenAI model ke hisaab se request token estimate karta hai, schema/instructions samet aur output headroom ke saath. Unknown model tokenizer par review fail-safe hota hai; char limit alag hard ceiling hai.

Local entry points: `npm start` (`node index.js`) aur `npm test` (`node --test`). Latest actual check results implementation map ke neeche record hain.

## HTTP aur webhook contract

Existing routes:

| Route | Contract |
| --- | --- |
| `GET /health` | Liveness response `{ status: "ok", service: "github-pr-review" }`; isse dependency/readiness ka claim nahi hota. |
| `POST /api/github/webhooks` | GitHub ka raw JSON body pehle HMAC SHA-256 se verify ho, uske baad JSON parse/filter/enqueue. Body limit 1 MiB. |
| `/api/inngest` | Inngest SDK ke served functions; JSON parser sirf is route ke scope mein. |

Webhook response behavior:

- Invalid/missing signature: `401`; invalid JSON ya invalid required metadata: `400`.
- Unrelated/unsupported event ya ineligible PR: `202` ignored.
- Inngest event accept kare tabhi `202` accepted. Queue failure par `503`, taaki GitHub delivery success acknowledge na ho.
- Internal HTTP error response generic ho; body, token ya internal provider error log/response mein na aaye.

`createApp()` handler/client/function registry ko inject kar sakta hai; bina injected GitHub handler ke webhook route jaanbujhkar `503` deta hai. Unknown route `404`, malformed JSON `400`, oversized body `413`, unsupported encoding/charset `415`, aur generic internal error `500` hai. `X-Powered-By` disabled hai. Inngest JSON body limit 1 MiB hai.

`index.js` validated config ke baad PostgreSQL `Store`, Inngest client, review function aur webhook handler wire karta hai. Config error secret values ke bina log hota hai; listener error sirf sanitized code log karta hai. SIGINT/SIGTERM par server naye connections lena rokta hai aur active requests drain karta hai; shutdown deadline 30 seconds hai.

Event name `github/pullrequest.review` rahe. Event ID GitHub `x-github-delivery` ho, jisse same delivery ID par redelivery deduplicate ho. Review event data shape:

```text
installationId, repositoryId, owner, repo, prNumber,
deliveryId, prKey, observedHeadSha, observedBaseSha, observedAt, action
```

Target events: `opened`, `synchronize`, `reopened`, `ready_for_review`; `edited` jab base retarget ya title change ho; `labeled`/`unlabeled` jab `skip-ai-review` eligibility badal sakta ho. Enqueue se pehle live PR state verify karo: allowlisted repository, open, non-draft, author policy, title opt-out aur label opt-out. Bot author default skip hota hai; `GITHUB_BOT_AUTHOR_ALLOWLIST` exact bot logins ka optional comma-separated override hai.

Opt-out hatne par eligible transition review enqueue kare. Opt-out lagne par cancel event bhejo; workflow later steps par fresh eligibility check karta hai. Event payload live GitHub state ka substitute nahi hai. Implementation event par pehle live PR fetch karta hai; ineligible PR ke liye cancel event bhejta hai.

GitHub failed deliveries automatic redelivery nahi maane jayenge. Manual redelivery wahi delivery ID reuse karti hai; GitHub docs past 3 days tak redelivery API/UI batate hain. Pilot ke liye operational alert aur documented manual redelivery procedure abhi deployment owner se finalize karna baaki hai. Publication recovery scheduled Inngest job code mein maujood hai.

## Review workflow design

Workflow teen durable steps mein rahe, taaki raw repository code durable step output ya logs mein na aaye.

### 1. Snapshot aur pre-checks

- Live PR fetch: `state`, `draft`, title, author, labels, base SHA aur head SHA.
- Repository allowlist, kill switch, opt-out aur bot-author policy check.
- Same snapshot ke existing bot review ko paginated lookup se dhoondo; milne par duplicate review skip.
- Snapshot identity mein repository, PR, base SHA, head SHA aur review configuration/version shamil hon.

### 2. Context, redaction, budget aur AI

- Current PR diff ke files paginate karo; file content reviewed head SHA se lo. Pagination shuru aur khatam hone ke baad base/head snapshot verify karo.
- Defaults: 30 files, 80,000 characters, configurable model token ceiling, maximum 3,000 file records. Limit hit ho to review explicitly partial ho. Poore hunks ko priority do; hunk ko adhoora kaatkar misleading input mat banao.
- Binary/generated files, lockfiles, known secret files, symlinks aur submodules exclude karo. Renames ke old/new path aur deleted lines ke LEFT anchors sahi map karo.
- Missing patch ko empty diff mat samjho. Recoverable ho to fetch/reconstruct; warna file ko reason ke saath skipped coverage mein rakho.
- Fork ke liye accessible diff review ho sakta hai; unavailable file context coverage gap ke roop mein report ho. Fork code execute na ho.
- Complete outgoing model payload par redaction lagao: diff, surrounding file context, PR description/metadata jo bheje ja rahe hon, aur prompt-derived user content. AI output aur final publication text par bhi secret filtering/sanitization ho. Pattern redaction guaranteed detection nahi hai.
- Token count tokenizer/model ke mutabiq measure karo; prompt, serialized context, schema/instructions aur output headroom budget mein gino. Bytes ko tokens ka exact substitute mat banao.
- Budget reserve API call se pehle ho. Counter unavailable ho to AI call skip. Call se pehle skip ho to reservation release. Usage mile to refusal/incomplete/stale result par bhi actual usage reconcile. Timeout/unknown outcome mein maximum reservation rakho.
- Raw code sirf isi AI step ke andar rahe. Step ka durable output sirf validated, length-capped findings, minimal summary/coverage aur non-sensitive metadata ho.

### 3. Freshness check aur publication

- Review publish karne se pehle live PR eligibility, kill switch, base/head SHAs aur existing review marker dobara check karo. Har retry mein freshness dobara verify ho; cached result par bharosa na karo.
- Final freshness check, existing-review lookup aur GitHub write ek publish step mein hon. `createReview` mein explicit `commit_id` reviewed head SHA ho.
- Snapshot stale ho to result `skipped_stale`; purana result publish na ho. Latest snapshot ka review ensure/enqueue karo. Stale/failed/incomplete run owner ko completion notification na de.
- Hidden marker identity mein repo, PR, base SHA, head SHA aur review config version bind hon. Lookup paginated ho aur authenticated bot identity match kare.
- Publication ke pehle snapshot key par atomic `publishing` record claim karo. Success par `published` status aur GitHub review ID persist karo.
- POST timeout/ambiguous response par marker se pehle reconciliation karo; blind POST retry nahi. Unresolved status `publish_unknown` ho aur alert/recovery path mein jaye.
- Recovery job paginated marker lookup kare. 15-minute TTL retry decision ka samay hai, pehli POST fail hone ka proof nahi. Absent marker par retry policy conservative rakho; exactly-once guarantee ka claim na karo.
- GitHub location-specific `422` par freshness check ke baad invalid inline anchors ko summary mein move karke maximum ek corrected attempt. Generic/spam `422` par blind fallback nahi. Saare anchors invalid hon to valid snapshot par summary-only `COMMENT` review.
- Shared installation-level write scheduler implement karo; same installation ke writes ke beech kam se kam ek second. Har PR ka independent sleep global pacing nahi deta.

## AI output aur publication text

Responses API strict JSON Schema aur `store: false` use kare. Model ko tools, shell, credentials ya write access nahi. PR text/code untrusted prompt-injection input hai.

Output: `summary` aur findings jinke fields `path`, nullable `line`/`side`, `severity`, `confidence`, `title`, `explanation`, `failureScenario`, nullable `suggestedFix` hon. Sirf diff se introduce hua concrete correctness/security bug include karo; style, speculation aur pre-existing issues suppress karo. Schema ke baad app-level validation required hai: path reviewed thi, evidence diff/context se supported hai, line/side valid hai, scenario finding ko substantiate karta hai. Unsupported finding discard ho. Correct finding ka inline anchor invalid ho to file reference ke saath summary fallback mein rakho. Maximum paanch findings.

Refusal, incomplete ya invalid AI response clean review nahi: run ko failed/incomplete mark karo. Ranking impact/severity, evidence strength, phir confidence par ho.

Review body mein alag sections hon:

1. `AI-generated report` aur PR author ke changes ka summary.
2. Bot findings; bot ne code change nahi kiya ye clear rahe.
3. Reviewed commit, reviewed/skipped file coverage, partial/summary-only status.
4. Configured owner ka at most ek mention, model output se bahar.

Per-file “kya badla aur behavior par kya asar hua” sirf verified context par report ho; unverified behavior ka claim na ho. Mention, issue reference, external links aur unsafe Markdown sanitize/neutralize karo.

## Concurrency, retry aur state

- PR concurrency key: `installationId + repositoryId + prNumber`; per-PR concurrency 1, initial global concurrency 5.
- Debounce: 20 second quiet period, maximum 2 minute wait. Debounce in-flight stale review ko solve nahi karta; snapshot checks phir bhi mandatory hain.
- Inngest retry owner, maximum 3 retries. SDK/Octokit/OpenAI nested automatic retries disable/coordinate karke retry multiplication roko. Rate-limit headers aur `retry-after` follow karo; permission/config errors permanent classify karo.
- Successful AI step ke baad publication retry par AI call repeat na ho.
- External GitHub write state: `publishing`, `published` (review ID ke saath), `publish_unknown`; unresolved record alert/log aur recovery job mein jaye.
- Budget: per repository + global daily cap, UTC reset; per-PR cap aur global kill switch alag controls hon. Reservation ID run + step se idempotent ho. Counter updates atomic hon.

## Privacy, logging aur rollout

Repository owners ko bataya jaye ki diff/context OpenAI ko bheja jata hai. Secrets, prompts aur raw source logs mein na hon. Logs: run ID, snapshot, status, duration, token usage, coverage aur sanitized error category. Webhook delivery failures aur unresolved publication status operationally visible hon.

Pehle ek repository pilot. Measure: duplicate reviews (target zero), false-positive rate, developer usefulness, average cost aur latency. Known-bug/clean fixtures se quality evaluate karo; owner ke account se real PR par notification verify karne ke baad hi aur repositories enable karo.

## Current implementation map (22 Nov 2026 implementation and verification)

| Area | Current code | Status |
| --- | --- | --- |
| Server/routes | `index.js`, `app.js` | Health, raw-body webhook signature verification, Inngest serving, function wiring aur graceful shutdown implemented. |
| Config | `config.js`, `.env.example` | Zod validation; repository/bot allowlists, PostgreSQL URL, char/file/token/output limits, global/repo/PR daily budgets, concurrency aur kill switch implemented. |
| GitHub | `github/client.js`, `github/webhook.js` | Installation Octokit; relevant open/sync/reopen/draft/close/title/base/skip-label transitions; current PR eligibility lookup; bot allowlist; delivery ID and cancellation event implemented. |
| Inngest | `inngest/client.js`, `inngest/function/index.js`, `inngest/function/review-pr.js`, `inngest/function/recover-publications.js` | Review workflow and scheduled recovery are wired at runtime. Review uses 20s debounce (2m maximum), 3 retries, global/per-PR concurrency and newer ineligible-event cancellation; fresh snapshot checks remain. SDK v4 options were checked against official docs. |
| Context/safety | `review/context.js`, `review/safety.js`, `review/tokenizer.js` | SHA-specific diff/context; secret/generated/lockfile/binary/symlink/submodule exclusions; missing-patch recovery via GitHub compare merge base; rename/deleted LEFT anchors; whole-hunk token/char ceilings; request/output redaction and tokenizer counting implemented. Compare lookup fail ho to file skipped coverage mein jati hai. Header-jaisi `+++`/`---` source lines hunk ke andar valid changes rehti hain. |
| AI | `review/ai.js` | Responses API with strict schema, `store: false`, no SDK retries, exact changed-line evidence, supplied-path validation, evidence-line/side anchor alignment, confidence/severity/evidence ranking, safe file-change report, refusal/incomplete handling and max-five findings implemented. |
| Publish | `review/publish.js` | Bot marker pagination, explicit head SHA, fresh eligibility/snapshot checks, summary fallback for invalid anchors, bounded report sections that retain coverage, one location-specific 422 correction, generic 422 stop, ambiguous-write reconciliation, publication state/review ID, shared installation pacing and 15m recovery implemented. Marker lookup errors fail closed before recovery writes. |
| State/budget | `review/store.js` | PostgreSQL runtime schema, atomic UTC global/repo/PR reservations, actual usage reconciliation, pre-call release/unknown outcome handling, persisted safe result, publication claims/recovery claims and installation write scheduler implemented. Live DB behavior is not exercised. |
| Tests | `tests/backend.test.js` | 35 synthetic `node:test`/Supertest cases cover webhook, context, tokenizer, AI evidence/anchor alignment, merge-base patch recovery, header-like diff lines, bounded report coverage, stale/ambiguous publication, recovery and budgets. `npm test`: 35/35 passed. Not a live integration or quality-fixture pilot. |

`package.json` mein direct dependencies `@octokit/auth-app`, `diff`, `dotenv`, `express`, `inngest`, `js-tiktoken`, `octokit`, `openai`, `pg`, `zod` hain; dev dependency `supertest` hai. Current `test` script `node --test` hai. `npm ls --depth=0` passed; manifest versions resolve hue. `js-tiktoken` install ke waqt npm ne 7 advisories report kiye (5 moderate, 2 high) aur `protobufjs` ka postinstall script block hua. `npm audit fix` nahi chalaya; advisories ka package-level triage deployment se pehle karna baaki hai.

Latest actual checks (22 Nov 2026): `npm test` approved execution mein pass (35 tests, 0 failures); changed-file `node --check` pass. Is turn ka initial sandboxed `npm test` attempt loopback `EPERM` ke kaaran 8 HTTP tests launch nahi kar saka; 27 tests pass hue. Previous implementation checks mein all-JS syntax, `npm ls --depth=0`, aur 2 Inngest functions ka smoke registration pass hua tha; is turn mein repeat nahi hua. No credentials or secrets were used.

Current repo mein `.env.example` aur `.gitignore` hain. `README.md`, `Dockerfile`, `.dockerignore` aur separate database migration directory current inventory mein nahi mile. `review/store.js` `review_budget`, `review_reservation`, `review_publication` tables ko runtime par `CREATE TABLE IF NOT EXISTS` se initialize karta hai. `inngest/client.js` ka client ID `github-pr-review-app` hai. `github/client.js` Octokit retry aur throttle middleware disable karta hai.

## Snapshot freshness invariant

Maan lo review `abc123` head aur base `baseA` par start hua, phir PR `def456` par push ho gayi. `abc123` ka AI result publish nahi hoga: live base/head mismatch par `skipped_stale` return karke latest snapshot ka event ensure karo. Har publish retry par freshness fresh read honi chahiye. Explicit `commit_id` comment ko sahi revision se jodta hai, lekin check aur write ke beech push race ko eliminate nahi karta. Purane published reviews history mein reh sakte hain; latest snapshot par issue dobara evaluate hoga.

## Remaining work outside local application-code scope

1. Production PostgreSQL provision karke runtime schema initialization, connection policy, migrations/backup ownership aur concurrency behavior ko live DB par verify karna.
2. GitHub App permissions/events ko selected repository ke liye configure karna; secrets ko secure deployment environment mein set karna; GitHub/OpenAI data handling notice aur pilot owner confirm karna.
3. Inngest production deployment mein review + recovery functions deploy/register karke webhook delivery/redelivery aur operational logs/alert routing verify karna. Current code unresolved publication ko sanitized `console.error` event ke roop mein record karta hai; external paging integration nahi hai.
4. Ek selected repository par known-bug/clean fixtures ke saath review quality, duplicate rate, false positives, latency, token cost aur owner notification verify karna.
5. npm install ke reported advisories ko dependency metadata se triage karna; bina review ke automatic upgrade na chalana.

### Railway pilot setup progress (22 Nov 2026)

- User ne Railway ko app/PostgreSQL host aur `pkcoder-9785/gihub-pr-riview` ko selected pilot repository aur bot-source repository choose kiya. Review owner mention `pkcoder-9785` hai. `.env.example` mein allowlist aur owner set hain; real credentials nahi hain. `package.json` aur lockfile mein Node `>=22` engine set hai, kyunki installed OpenAI package ko Node 22+ chahiye.
- Connected GitHub account ko pilot repository par admin access hai, lekin repo empty hai. Local project ka apna Git root nahi hai; parent home-directory Git repository ko source repo mat samjho. Source upload/commit, Railway service, database, GitHub App, production env, public domain aur pilot PRs abhi create nahi hue.
- Railway connector ka connection option diya gaya hai; connection confirm nahi hua. Railway CLI locally available nahi mila. New Railway services ke liye deprecated `railway.json`/`railway.toml` config-as-code mat add karo; current Railway docs Railpack se `npm start` auto-detect karte hain. Service dashboard/connector mein `/health` deployment healthcheck configure karna hai.
- GitHub App permissions: Contents read, Pull requests write, Metadata read. Subscribe pull request events and point webhook to `https://<Railway-domain>/api/github/webhooks`; Inngest serve endpoint `https://<Railway-domain>/api/inngest`. App installation selected repository tak restrict karni hai. Production env mein `NODE_ENV=production`, Railway-provided `DATABASE_URL`, GitHub App ID/private key/webhook secret, OpenAI key/model, Inngest event/signing keys aur repository allowlist chahiye. Initial rollout mein `REVIEW_KILL_SWITCH=true` rakho, pilot ready hone par hi enable karo.
- Read-only dependency audit: `npm ls --depth=0` pass; `npm audit --omit=dev --json` ne 7 production advisories report kiye (5 moderate, 2 high). High finding nested `inngest/node_modules/zod@3.25.76` par hai; installed direct `zod@4.6.7` affected nahi. Npm registry ke current latest `inngest@4.26.2` mein `zod:^3.25.0` dependency hai. Audit ka suggested `inngest@0.3.0` downgrade current v4 API ke saath incompatible hoga. `npm audit fix --omit=dev --dry-run --json` ne peer-dependency warnings ke saath wahi high finding rakhi, isliye automatic fix nahi chalaya. Moderate chain Inngest ke OpenTelemetry dependencies se `gcp-metadata -> gaxios -> rimraf -> glob -> minimatch` tak hai. Deployment se pehle package-level mitigation/acceptance decide karna hai.
- Railway deployment, GitHub App, data-handling notice, alert routing, live DB test, quality fixtures aur owner notification verification abhi pending hain. Koi production secret read ya store nahi kiya gaya.

Inngest SDK v4 ke concurrency, debounce, cancellation, retries aur durable event-send contracts official docs se verify hue. GitHub docs ke mutabiq automatic redelivery nahi hoti aur manual redelivery 3 din tak available hai. References: [Inngest concurrency](https://www.inngest.com/docs/reference/typescript/v4/functions/concurrency), [debounce](https://www.inngest.com/docs/reference/typescript/v4/functions/debounce), [cancel-on](https://www.inngest.com/docs/reference/typescript/v4/functions/cancel-on), [retries](https://www.inngest.com/docs/durable-execution/guides-and-advanced/error-handling/retries), [durable sendEvent](https://www.inngest.com/docs/durable-execution/primitives/step-sendevent), [GitHub webhook redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).

## Codex workflow

Project work main Codex session mein hi plan, implement, review aur report hota hai; subagents aur delegation disabled hain. Read `AGENTS.md` and this file before resuming. Start or resume the project-scoped CLI session with `bash scripts/codex-project.sh` (add `resume --last` to resume the latest session). Commit, push, deploy ya destructive operation explicit user approval ke bina nahi.

## Next implementation sequence

Application-code implementation steps 1–6 complete hain. Next work is deployment-owned live verification: provision/configure integrations, run the selected-repository pilot, and record quality/operations outcomes here. No production credentials or selected-repository authorization were available in this local session, so live steps are not claimed complete.

## Change log

| Date | Change | Verification |
| --- | --- | --- |
| 2026-11-21 | Config, Express app, server startup/shutdown aur Inngest scaffold work | Historical checks neeche prior notes mein the; is update mein dobara execute nahi hue. |
| 2026-11-22 | Persistent Codex team config/workflow documented | Historical evidence `.codex/validation.md` mein hai; is update mein dobara verify nahi hua. |
| 2026-11-22 | Corrected Plan (v4) ko current design aur source tree se reconcile kiya; stale implementation claims replace kiye | PDF ke 6 pages text/render se inspect hue; current source aur `package.json` read-only inspect hue; backend read-only gap audit mila. Koi code/test command run nahi hua. |
| 2026-11-22 | User preference persisted: project updates aur problem/fix records isi Markdown mein; problems ko documented contracts ke mutabiq solve karo | Notes read-back se wording verify hui; koi code/test command run nahi hua. |
| 2026-11-22 | User request par persistent subagent workflow hata kar project ko main-agent-only kiya; CLI config mein agents disable kiye aur launcher ko team-neutral naam diya | `AGENTS.md`, `.codex/config.toml`, `.codex/README.md`, launcher aur is file ka read-back/leftover-reference inspection hua. Application tests nahi chalaye; change workflow/config/docs tak seemit tha. |
| 2026-11-22 | v4 local implementation complete: webhook eligibility/cancellation, bounded token-aware context, strict AI evidence validation, PR/repo/global budgets, safe durable outputs, publication recovery aur installation pacing | `npm test` 30/30 pass; changed-file aur full implementation JS syntax checks pass; `npm ls --depth=0` pass; Inngest runtime smoke registered 2 functions. Live services/pilot not run. |
| 2026-11-22 | Publication recovery marker-lookup failure ko fail-closed kiya; unavailable lookup par retry POST rok diya | Naya regression test mila; final `npm test` 30/30 pass; `review/publish.js` aur `tests/backend.test.js` `node --check` pass. |
| 2026-11-22 | `js-tiktoken` add karke token limit ko model-aware kiya; dependency install warnings note kiye | Dependency tree resolved; npm reported 7 advisories (5 moderate, 2 high) and blocked a `protobufjs` postinstall script. No automatic audit fix performed. |
| 2026-11-22 | v4 code review ke 4 issues fix: missing patch ke liye merge base, header-jaisi diff lines, evidence ko exact anchor se bind karna, aur report coverage ko truncation se bachana | 5 regression tests add hue; sandboxed `npm test` mein 27 pass aur 8 loopback `EPERM` se blocked; approved rerun mein 35/35 pass. `review/context.js`, `review/ai.js`, `review/publish.js`, `tests/backend.test.js` syntax checks pass. Live GitHub/DB pilot pending. |
| 2026-11-22 | Railway aur empty `pkcoder-9785/gihub-pr-riview` pilot target choose hue; example allowlist set ki; deployment/audit blockers triage kiye | GitHub repo metadata read-only inspect hua; `npm ls --depth=0` pass. `npm audit --omit=dev --json`: 7 production advisories, no package changes. Sandbox DNS failure ke baad approved registry query se audit aur latest Inngest dependency metadata mila. Railway connector abhi unconfirmed; no external deployment/write. |
| 2026-11-22 | Same public repo ko bot-source repo aur `pkcoder-9785` ko owner mention choose kiya; example env aur Node runtime floor update ki | `package.json`/lockfile mein Node `>=22`, `.env.example` mein selected public values read-back kiye. `npm audit fix --dry-run` ne high Inngest/Zod advisory ka compatible fix nahi diya. Koi commit/push/deploy nahi hua. |

## Resume prompt

> PROJECT_NOTES.md aur AGENTS.md padho, actual source se status verify karo, aur Corrected Plan v4 ke current next step se incremental kaam karo. Is notes file ko har completed change ke baad update karo. Secrets ya raw repository source ko notes/log mein kabhi mat likho.
