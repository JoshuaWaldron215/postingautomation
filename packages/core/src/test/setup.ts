import { loadDotEnv } from "../lib/env";
loadDotEnv();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/synthos_test";
process.env.STORAGE_DIR = process.env.TEST_STORAGE_DIR ?? "./storage-test";
process.env.APP_SECRET = "test-secret-0123456789abcdef0123456789abcdef";
