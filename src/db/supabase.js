import { createClient } from '@supabase/supabase-js';
import { config, assertConfig } from '../config.js';

assertConfig(['supabaseUrl', 'supabaseKey']);

export const supabase = createClient(config.supabaseUrl, config.supabaseKey);

export async function insertLaunch(record) {
  const { data, error } = await supabase
    .from('launches')
    .insert(record)
    .select()
    .single();
  if (error) {
    // Duplicate mint address is expected/harmless (same token seen twice)
    if (error.code === '23505') return null;
    console.error('insertLaunch error:', error.message);
    return null;
  }
  return data;
}

export async function getOpenLaunchesForTracking(maxAgeMinutes = 60) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('launches')
    .select('*')
    .gte('detected_at', cutoff)
    .order('detected_at', { ascending: false });
  if (error) {
    console.error('getOpenLaunchesForTracking error:', error.message);
    return [];
  }
  return data;
}

export async function insertPriceSnapshot(snapshot) {
  const { error } = await supabase.from('price_snapshots').insert(snapshot);
  if (error) console.error('insertPriceSnapshot error:', error.message);
}

export async function getAllLaunchesWithSnapshots() {
  const { data, error } = await supabase
    .from('launches')
    .select('*, price_snapshots(*)')
    .order('detected_at', { ascending: false });
  if (error) {
    console.error('getAllLaunchesWithSnapshots error:', error.message);
    return [];
  }
  return data;
}
