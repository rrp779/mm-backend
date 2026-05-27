const mongoose = require("mongoose");

// Railway public URL (target)
const TARGET = "mongodb://mongo:aagIbNOfWYTunYctCwTrMSywCQeHnDlO@maglev.proxy.rlwy.net:47537";

// Atlas (source) - same as your .env
const SOURCE = "mongodb+srv://ritesh_db_user:AswsLk1lm6LGJ3L4@mm-mobile-app.3knifbd.mongodb.net/mm-mobile-app";

async function migrate() {
  console.log("Connecting to Atlas (source)...");
  const source = await mongoose.createConnection(SOURCE, {
    serverSelectionTimeoutMS: 30000,
  }).asPromise();
  console.log("✅ Atlas connected");

  console.log("Connecting to Railway (target)...");
  const target = await mongoose.createConnection(TARGET, {
    serverSelectionTimeoutMS: 30000,
  }).asPromise();
  console.log("✅ Railway connected");

  const collections = await source.db.listCollections().toArray();
  console.log("Collections found:", collections.map(c => c.name));

  for (const col of collections) {
    const name = col.name;
    const docs = await source.db.collection(name).find({}).toArray();

    if (docs.length === 0) {
      console.log(`⏭  Skipping ${name} (empty)`);
      continue;
    }

    await target.db.collection(name).deleteMany({});
    await target.db.collection(name).insertMany(docs);
    console.log(`✅ Migrated [${name}]: ${docs.length} docs`);
  }

  await source.close();
  await target.close();
  console.log("\n🎉 Migration complete! Railway MongoDB now has all your data.");
}

migrate().catch(err => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});