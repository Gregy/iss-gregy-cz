-- How long the push service should keep an alert for a phone it can't reach,
-- in seconds from the booked time. NULL (alerts booked by older app versions): 10 minutes.
ALTER TABLE alerts ADD COLUMN ttl INTEGER;
