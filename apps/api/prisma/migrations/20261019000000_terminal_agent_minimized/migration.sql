-- Terminal snapshot metadata (S7): which agent a pane launches (null = plain
-- shell) and its collapsed state, so the desktop's cloud snapshot round-trips.
ALTER TABLE "Terminal" ADD COLUMN "agent" TEXT;
ALTER TABLE "Terminal" ADD COLUMN "minimized" BOOLEAN NOT NULL DEFAULT false;
