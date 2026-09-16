import { prisma } from './helpers';

/**
 * Runs once before the suite, after both webServer entries report ready.
 * A cold `tsx watch` + a fresh connection to the pooled Supabase Postgres
 * can still take a few seconds past that point for the FIRST real request —
 * without this, the suite's first test alone would eat that latency and
 * intermittently blow its own timeout, while every later test (hitting an
 * already-warm connection) sails through. One throwaway query here absorbs
 * that cost before any test's clock starts.
 */
export default async function globalSetup() {
  await prisma.location.findFirst();
  await prisma.$disconnect();
}
