export const environment = {
  production: false,

  // Paste your Supabase Project URL here (Settings → API → Project URL)
  supabaseUrl: 'https://ktutdqrxeauxpeuocpyy.supabase.co',

  // Paste your Supabase publishable key here (sb_publishable_...)
  // Never put SUPABASE_SECRET_KEY / service_role in this file.
  supabaseAnonKey: 'sb_publishable_V4M1CYcYqorxeHpiH1C5UA_RNDPS-Eq',

  // Colyseus WebSocket (local game server)
  gameServerUrl: 'ws://localhost:2567',

  // Used by existing Angular services (same local server over HTTP + WS)
  gameServerWsUrl: 'ws://localhost:2567',
  gameServerHttpUrl: 'http://localhost:2567',
};
