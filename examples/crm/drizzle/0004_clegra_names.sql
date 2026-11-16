ALTER TABLE "modelapp_store" RENAME TO "clegra_store";--> statement-breakpoint
ALTER INDEX "modelapp_store_expires_at" RENAME TO "clegra_store_expires_at";--> statement-breakpoint
UPDATE "companies" SET "erp_customer" = 'clegra://' || substr("erp_customer", 12) WHERE "erp_customer" LIKE 'modelapp://%';
