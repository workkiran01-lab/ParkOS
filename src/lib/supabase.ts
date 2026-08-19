import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl) {
  throw new Error(
    'Missing VITE_SUPABASE_URL. Copy .env.example to .env.local and set it to your Supabase project URL.',
  )
}

if (!supabaseAnonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and set it to your Supabase publishable key.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
