-- Additive: per-venue roster import memory (role label -> role, printed name -> staff member).
-- CreateTable
CREATE TABLE "roster_role_aliases" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "normalized_label" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_role_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_name_aliases" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_name_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_role_aliases_role_id_idx" ON "roster_role_aliases"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "roster_role_aliases_location_id_normalized_label_key" ON "roster_role_aliases"("location_id", "normalized_label");

-- CreateIndex
CREATE INDEX "roster_name_aliases_user_id_idx" ON "roster_name_aliases"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roster_name_aliases_location_id_normalized_name_key" ON "roster_name_aliases"("location_id", "normalized_name");

-- AddForeignKey
ALTER TABLE "roster_role_aliases" ADD CONSTRAINT "roster_role_aliases_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_role_aliases" ADD CONSTRAINT "roster_role_aliases_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_name_aliases" ADD CONSTRAINT "roster_name_aliases_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_name_aliases" ADD CONSTRAINT "roster_name_aliases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
