-- Username availability check for registration (anon-safe, minimal leak)
CREATE OR REPLACE FUNCTION public.is_username_available(p_username text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE username_normalized = lower(trim(p_username))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_username_available(text) TO anon, authenticated;
