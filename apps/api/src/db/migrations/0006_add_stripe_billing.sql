ALTER TABLE users ADD COLUMN stripe_customer_id text UNIQUE;
ALTER TABLE users ADD COLUMN subscription_status text NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN subscription_id text;
ALTER TABLE users ADD COLUMN subscription_current_period_end timestamptz;
