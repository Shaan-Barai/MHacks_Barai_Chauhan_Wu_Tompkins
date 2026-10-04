# Scrap Saver

A simple dining hall dashboard with daily food-waste estimates, calendar suggestions, and meal schedules for regular days and events. The preview uses synthetic plate records. Menus and schedule settings are saved in the current browser.

Current measurement context (October 3, 2026): **Gemini food classification →
segmentation mask → code-counted Pixels wasted**. The new primary quantity is
foreground food pixels in compatible normalized images. See the shared
[measurement contract](../contracts/measurement.md) and
[decision record](contracts/decisions.md). The existing preview's percentage
calculations are legacy behavior pending migration; this context change does
not implement mask generation. Camera placement remains deferred.

From this application directory:

```bash
npm ci
npm run demo:generate
npm run build:ui
npm start
```

Open `http://127.0.0.1:4173`. Use `PORT=4174 npm start` if the default port is in use. Run `npm run test:demo` and `npm run typecheck` to check the calculations and types.

The [UI revision handoff](docs/ui-revamp.md) explains the plate average, schedules, changed files, and verification. The [original demo runbook](docs/demo-readiness.md) records the synthetic fixture and remaining live-integration work.

## Original SpacetimeDB starter

The original starter remains below. Its database module still contains the example person table; it is not connected to the preview.

Get a SpacetimeDB TypeScript app running in under 5 minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ installed
- [SpacetimeDB CLI](https://spacetimedb.com/install) installed

Install the [SpacetimeDB CLI](https://spacetimedb.com/install) before continuing.

---

## Create your project

Run the `spacetime dev` command to create a new project with a TypeScript SpacetimeDB module.

This will start the local SpacetimeDB server, publish your module, and generate TypeScript client bindings.

```bash
spacetime dev --template basic-ts
```



## Explore the project structure

Your project contains both server and client code.

Edit `spacetimedb/src/index.ts` to add tables and reducers. Use the generated bindings in `src/module_bindings/` to build your client.

```
my-spacetime-app/
├── spacetimedb/             # Your SpacetimeDB module
│   └── src/
│       └── index.ts         # Server-side logic
├── src/
│   ├── main.ts              # Client application
│   └── module_bindings/     # Auto-generated types
└── package.json
```



## Understand tables and reducers

Open `spacetimedb/src/index.ts` to see the module code. The template includes a `person` table and two reducers: `add` to insert a person, and `sayHello` to greet everyone.

Tables store your data. Reducers are functions that modify data — they're the only way to write to the database.

```typescript
import { schema, table, t } from 'spacetimedb/server';

const spacetimedb = schema({
  person: table(
    { public: true },
    {
      name: t.string(),
    }
  ),
});
export default spacetimedb;

export const add = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    ctx.db.person.insert({ name });
  }
);

export const sayHello = spacetimedb.reducer(ctx => {
  for (const person of ctx.db.person.iter()) {
    console.info(`Hello, ${person.name}!`);
  }
  console.info('Hello, World!');
});
```



## Test with the CLI

Open a new terminal and navigate to your project directory. Then use the SpacetimeDB CLI to call reducers and query your data directly.

```bash
cd my-spacetime-app

# Call the add reducer to insert a person
spacetime call add Alice

# Query the person table
spacetime sql "SELECT * FROM person"
 name
---------
 "Alice"

# Call sayHello to greet everyone
spacetime call say_hello

# View the module logs
spacetime logs
2025-01-13T12:00:00.000000Z  INFO: Hello, Alice!
2025-01-13T12:00:00.000000Z  INFO: Hello, World!
```

## Next steps

- See the [Chat App Tutorial](https://spacetimedb.com/docs/tutorials/chat-app) for a complete example
- Read the [TypeScript SDK Reference](https://spacetimedb.com/docs/clients/typescript) for detailed API docs
