# FieldLedger

FieldLedger is a construction timecard and labour-costing demo with a responsive web app and a native Android app. It follows one timecard from the field through foreman review to an auditable posting against the project budget.

[Try the live web app](https://fieldledger.swoop.video/) · [Download the Android APK](https://github.com/yazanbaker94/fieldledger/releases/download/android-v1.0/fieldledger-android-v1.0.apk) · [Android source](android/) · [Watch both demos](#15-second-website-walkthrough)

The web app uses React and TypeScript. The Android app uses Kotlin and Jetpack Compose. Both use the same Express API and PostgreSQL data model.

## Try the workflow

1. As **Worker**, choose **Use 7 hours** and submit the timecard. Select **Go to foreman**.
2. As **Foreman**, choose **Return with a note**, use the example note, and send it back. Switch back to **Worker**, choose **Use 8 hours**, and resubmit.
3. Approve the corrected card as **Foreman**, then open **Manager**. The CAD $400 posting takes approved labour from CAD $9,700 to CAD $10,100 against the CAD $10,000 budget. The Cost Trail shows the increase and links to the source timecard.

The demo opens an isolated workspace with a fictional crew and sample timecards. **Reset demo** restores the starting data.

## 15-second website walkthrough

https://github.com/user-attachments/assets/47c1b8f1-1224-4546-8629-7f1635041f72

## 15-second Android walkthrough

https://github.com/user-attachments/assets/36d4fe32-0960-44e5-9444-46aa815f1c0b

## Screens from the running app

| Worker on a phone | Foreman reviewing the card | Manager after approval |
| --- | --- | --- |
| [![Worker mobile timecard form](docs/screenshots/worker.png)](docs/screenshots/worker.png) | [![Foreman reviewing the submitted timecard](docs/screenshots/foreman.png)](docs/screenshots/foreman.png) | [![Manager viewing approved labour over budget](docs/screenshots/manager.png)](docs/screenshots/manager.png) |

[View the correction screen](docs/screenshots/worker-correction.png) · [Native Android screenshots](android/screenshots/)

## How it works

- **Review controls.** The API checks the active role, timecard status, and revision. If the worker changes a card, the foreman must review the new revision before approving it.
- **Traceable costing.** Approval saves the applied hourly rate, exact cost, and audit event in one PostgreSQL transaction. The manager sees pending labour separately and can trace each approved posting back to its timecard.
- **Safe retries.** A submission keeps its request ID when the connection drops, so retrying can recover the result without creating a duplicate timecard.

### Foundry mapping

FieldLedger is a standalone implementation inspired by the [Foundry Ontology](https://www.palantir.com/docs/foundry/ontology/overview). This design would map to Foundry as follows.

| FieldLedger | Foundry equivalent |
| --- | --- |
| Validated fictional CSV inputs | Source datasets and a pipeline transform |
| Workers, projects, and timecards | Object types connected by links |
| Submit, return, resubmit, and approve commands | Governed Ontology Actions |
| Role-specific forms, queue, and budget view | Workshop views or a custom OSDK app |

## Run locally

Use Node.js 22.12 or newer and a dedicated PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL`.

```sh
npm ci
npm run build
npm start
```

Open [FieldLedger locally](http://localhost:3000). The server applies the schema and loads sample data at startup. For the native client, see the [Android build guide](android/README.md). The [deployment guide](deploy/README.md) covers the hosted setup.

<details>
<summary>Run the web tests</summary>

Point `DATABASE_URL` to a disposable PostgreSQL database for integration and browser tests.

```sh
npm test
npx playwright install chromium
npm run test:browser
```

</details>
