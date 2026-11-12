-- Top-down cut-out of one object per part name per job, stored in R2 under image_key.
ALTER TABLE job_parts ADD COLUMN image_key TEXT;
