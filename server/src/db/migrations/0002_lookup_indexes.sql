-- Indexes for correlated lookups found during scale testing (12,000 personnel).
-- Without these, searches that match a credential number or join credentials by
-- holder scan the credentials table once per personnel row.

CREATE INDEX credentials_personnel ON credentials (personnel_id);
CREATE INDEX credentials_contractor ON credentials (contractor_id);
CREATE INDEX verification_attempts_credential ON verification_attempts (credential_id);
CREATE INDEX movement_events_temporary_access ON movement_events (temporary_access_id);
CREATE INDEX movement_events_delivery ON movement_events (delivery_id);
CREATE INDEX visits_vehicle ON visits (vehicle_id);
CREATE INDEX deliveries_vehicle ON deliveries (vehicle_id);
CREATE INDEX alerts_attempt ON alerts (verification_attempt_id);
CREATE INDEX manual_reviews_requested_by ON manual_reviews (requested_by, status);
CREATE INDEX temporary_access_personnel ON temporary_access (personnel_id);
CREATE INDEX temporary_access_contractor ON temporary_access (contractor_id);
CREATE INDEX vehicles_personnel ON vehicles (personnel_id);
CREATE INDEX vehicles_contractor ON vehicles (contractor_id);
