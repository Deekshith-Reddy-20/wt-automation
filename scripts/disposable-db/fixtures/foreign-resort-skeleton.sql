-- A public schema created by another tool before this app's migrations ran:
-- same table names as the app (bookings, conversations, messages, ...) but
-- different columns, no accounts/profiles, RLS on. Mirrors the tables found
-- in the second hosted project on 27 Oct 2026. Used to rehearse
-- supabase/apply/vfarms_full_setup.sql. Fictitious data only.

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.property_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_name text NOT NULL, description text, address text,
  location_url text, contact_phone text, currency text NOT NULL DEFAULT 'INR', timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  acreage numeric, guest_room_count int NOT NULL, max_guests int, check_in_time time, check_out_time time,
  amenities jsonb NOT NULL DEFAULT '[]', guest_policies jsonb NOT NULL DEFAULT '{}', cancellation_policy jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.property_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, description text, storage_path text NOT NULL, display_order int NOT NULL DEFAULT 0, is_published boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.resort_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text, phone_e164 text NOT NULL UNIQUE, email text, preferred_language text NOT NULL DEFAULT 'en', source text NOT NULL DEFAULT 'whatsapp', marketing_opt_in boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.resort_leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.resort_contacts(id), enquiry_type text NOT NULL, status text NOT NULL DEFAULT 'new', priority text NOT NULL DEFAULT 'warm', check_in date, check_out date, guest_count int, budget numeric, notes text, assigned_to uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.resort_contacts(id), channel text NOT NULL DEFAULT 'whatsapp', status text NOT NULL DEFAULT 'open', bot_mode boolean NOT NULL DEFAULT true, assigned_to uuid, last_message_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES public.conversations(id), provider_message_id text UNIQUE, direction text NOT NULL, message_type text NOT NULL DEFAULT 'text', body text, delivery_status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.conversation_states (conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id), flow_name text NOT NULL, current_step text NOT NULL, collected_data jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_reference text NOT NULL UNIQUE, contact_id uuid NOT NULL REFERENCES public.resort_contacts(id), lead_id uuid REFERENCES public.resort_leads(id), booking_type text NOT NULL, status text NOT NULL DEFAULT 'pending', check_in date, check_out date, guest_count int NOT NULL, event_start timestamptz, event_end timestamptz, total_amount numeric NOT NULL DEFAULT 0, amount_paid numeric NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'INR', hold_expires_at timestamptz, special_requests text, confirmed_at timestamptz, cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_bookings_dates ON public.bookings (check_in, check_out);
CREATE TABLE public.booking_quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES public.bookings(id), base_amount numeric NOT NULL, tax_amount numeric NOT NULL DEFAULT 0, discount_amount numeric NOT NULL DEFAULT 0, total_amount numeric NOT NULL, advance_amount numeric NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'INR', status text NOT NULL DEFAULT 'draft', valid_until timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.event_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES public.bookings(id), event_type text NOT NULL, catering_required boolean NOT NULL DEFAULT false, decoration_requirements text, accommodation_required boolean NOT NULL DEFAULT false, budget numeric, approval_status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.availability_blocks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), start_date date NOT NULL, end_date date NOT NULL, block_type text NOT NULL, reason text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES public.bookings(id), provider text NOT NULL DEFAULT 'razorpay', provider_order_id text, provider_payment_id text UNIQUE, amount numeric NOT NULL, currency text NOT NULL DEFAULT 'INR', payment_type text NOT NULL, status text NOT NULL DEFAULT 'created', verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notification_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid REFERENCES public.bookings(id), contact_id uuid REFERENCES public.resort_contacts(id), notification_type text NOT NULL, scheduled_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.consent_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL REFERENCES public.resort_contacts(id), channel text NOT NULL, consent_type text NOT NULL, granted boolean NOT NULL, source text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pricing_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, booking_type text NOT NULL, rate_type text NOT NULL, amount numeric NOT NULL, currency text NOT NULL DEFAULT 'INR', start_date date, end_date date, minimum_nights int, tax_rate numeric NOT NULL DEFAULT 0, deposit_percentage numeric NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.resort_automations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text, trigger_type text NOT NULL, configuration jsonb NOT NULL DEFAULT '{}', is_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.resort_automation_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), automation_id uuid NOT NULL REFERENCES public.resort_automations(id), conversation_id uuid REFERENCES public.conversations(id), status text NOT NULL, input_data jsonb NOT NULL DEFAULT '{}', output_data jsonb NOT NULL DEFAULT '{}', error_message text, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
CREATE POLICY "Staff can read bookings" ON public.bookings FOR SELECT TO authenticated USING (true);

INSERT INTO public.property_settings (property_name, guest_room_count) VALUES ('V-Farms', 5);

-- A user who signed up before the app schema existed (no profile row yet).
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'early-signup@disposable.example.invalid', '{"full_name":"Early Signup"}', now(), now())
ON CONFLICT (id) DO NOTHING;
