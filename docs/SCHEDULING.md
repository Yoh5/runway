# Running the keeper on a schedule

A keeper that only runs when someone types a command is not a keeper. It is a
calculator. This is how Runway gets triggered on a cadence by a KeeperHub scheduled
workflow, with nobody at the keyboard.

The shape is deliberately small:

```
KeeperHub Schedule trigger
        |
        v
KeeperHub HTTP Request node  --POST /tick, x-runway-token-->  Runway
                                                                 |
                                              reads the chain, decides,
                                              and writes back through
                                              KeeperHub's execute API
```

Runway is the only piece that decides anything. KeeperHub is the clock at one end and
the execution layer at the other.

## 1. The endpoint

`pnpm serve` starts an HTTP server with exactly two routes:

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /health` | none | Answers `{"ok":true,"code":"ok"}`. For a platform's health check. Says nothing about whether a tick is running. |
| `POST /tick` | `x-runway-token` header | Runs one tick and returns what happened. |

Everything else is a `404`, a `GET /tick` is a `405`, and a missing or wrong token is a
`401` that never reaches the runner.

Three properties worth knowing before you point a scheduler at it:

- **One tick at a time.** A second request arriving while a tick is in flight is refused
  with `409` and `code: "in-progress"` rather than queued. A scheduler firing every 15
  minutes will eventually overlap a slow tick, and two ticks reading the same facts are
  at best wasted chain reads.
- **The policy comes from the environment, never from the request.** There is no field a
  caller can set to point the keeper at another treasury. The request body is not read at
  all.
- **The outcome is in the body, not only in the status code.** Every response carries
  `ok` and `code`. This is not decoration: KeeperHub's HTTP Request step
  (`lib/workflow/codegen/templates/http-request.ts`) returns the parsed body and never
  looks at `response.ok` or the status. To a workflow condition, a `401` body and a `200`
  body are both just "the step returned an object", so a failed tick is only detectable
  if the failure is stated inside the body. Branch on `ok`, not on the status code.

Response from a tick that ran:

```json
{
  "ok": true,
  "code": "ok",
  "result": {
    "startedAt": "2026-09-09T00:27:00.475Z",
    "decision": "reduce",
    "runwaySec": "202106",
    "breach": true,
    "adjustments": 0,
    "writes": [],
    "escalations": [{ "kind": "floors-exceed-budget", "delivered": false }]
  }
}
```

That is a real response from this endpoint, taken with the demo treasury already shed to
its floors: the decision is still `reduce` and the treasury is still in breach, but there
is nothing left to cut that the mandate allows, so zero writes and an honest escalation.

## 2. Environment

The four variables from `docs/SETUP.md`, plus:

| Variable | Meaning |
| --- | --- |
| `RUNWAY_TRIGGER_TOKEN` | The shared secret. At least 32 characters, or the server refuses to start. Generate one with `node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`. |
| `RUNWAY_POLICY` | Policy path. Defaults to `policies/treasury.sepolia.yaml`. |
| `PORT` | Defaults to `8080`. Hosting platforms set this themselves. |

The token is a bearer credential for something that moves money. Treat it exactly as you
treat `KEEPERHUB_API_KEY`: never in a repository, never in a chat message, never in a
screenshot. If it leaks, rotate it in the host's environment and in the workflow's header
at the same time -- the endpoint fails closed on a wrong token, so a rotation cannot
double-spend, it can only interrupt the schedule.

## 3. Hosting it

Any platform that runs a Node process and gives it a public hostname works. What it needs:

- Node 22 or newer, `pnpm install`, start command `pnpm serve`.
- The environment variables above, set as secrets on the platform rather than in a file.
- A health check pointed at `GET /health`.

Two things to expect on a hosted instance:

- **The filesystem is usually ephemeral.** Runway still writes each run to `runs/`, but on
  a platform that recycles the instance that copy does not survive. Every run record is
  therefore also logged as a single JSON line, so the platform's log retention holds the
  evidence. A failure to write the file never turns a completed tick into a reported
  failure: the writes already happened on chain.
- **Cold starts.** On a plan that sleeps idle instances, the first request after a sleep
  pays the boot time. A tick that reads the chain and posts writes can take tens of
  seconds anyway, so give the workflow's step room.

## 4. The KeeperHub scheduled workflow

In KeeperHub, create a workflow with two nodes.

**Trigger: Schedule.** Pick the cadence from the policy, not from a habit. The useful
number is `minRunwayHours`: the keeper needs to notice a breach well before the runway
runs out, and it can only act on what it last read. With `minRunwayHours: 72` on the demo
policy, every 15 minutes is far more often than necessary and costs nothing but chain
reads; hourly is defensible. A cadence longer than a few hours makes the threshold
decorative.

**Action: HTTP Request.**

| Field | Value |
| --- | --- |
| Method | `POST` |
| Endpoint | `https://<your-host>/tick` |
| Headers | `{"x-runway-token": "<the token>"}` |
| Body | leave empty -- it is not read |

Optionally add a **Condition** node after it that branches on `ok == false`, and send
yourself a notification from the false branch. That is what turns a silent scheduled
failure into something you find out about, and it is the reason `ok` is in the body.

## 5. Verifying it

From your own machine, against the deployed host:

```bash
curl -s https://<your-host>/health
# {"ok":true,"code":"ok"}

curl -s -X POST https://<your-host>/tick
# {"ok":false,"code":"unauthorized"}    <- no token: nothing ran

curl -s -X POST -H "x-runway-token: <the token>" https://<your-host>/tick
# {"ok":true,"code":"ok","result":{...}}
```

Then `pnpm verify-rates` reads the live rates back off the chain, independently of
anything the endpoint said about itself.

## What this does not do

- It does not retry a failed tick. The next scheduled run is the retry, and it recomputes
  from fresh chain state rather than replaying a stale decision, which is the safer of the
  two behaviours for money.
- It does not alert anyone on its own. The escalation webhook in the policy covers the
  cases the keeper can see; nothing yet covers the keeper itself being down. A condition
  node on `ok == false` in the workflow is the closest thing available today, and it only
  fires when the workflow ran at all.
- It holds no state between ticks. Every decision is made from what the chain says at that
  moment, which is why an interrupted or duplicated schedule cannot corrupt anything.
