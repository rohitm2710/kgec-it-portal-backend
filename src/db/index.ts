import { neon, Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleServerless } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as dotenv from "dotenv";
import * as schema from "./schema.js";

dotenv.config();

neonConfig.webSocketConstructor = ws;

const databaseUrl = process.env.DATABASE_URL || "postgresql://neondb_owner:password@ep-cool-darkness-123456-pooler.ap-southeast-1.aws.neon.tech/kgec_it_portal?sslmode=require";

// 1. Fast HTTP Client for single-statement reads/writes
const sql = neon(databaseUrl);
export const dbHttp = drizzleHttp(sql, { schema });

// 2. WebSocket Pool Client for interactive ACID transactions (db.transaction)
const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzleServerless(pool, { schema });

export { schema };
