ALTER TABLE gifts ADD COLUMN deleted_at TEXT;
ALTER TABLE stores ADD COLUMN deleted_at TEXT;
CREATE INDEX redemptions_pending_gift ON redemptions(gift_id) WHERE status = 'confirmed';
CREATE INDEX redemptions_pending_store ON redemptions(store_id) WHERE status = 'confirmed';
