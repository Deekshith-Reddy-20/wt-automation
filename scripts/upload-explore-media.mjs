// Upload the Explore V-Farms photos / video to the public `flow-media` bucket.
//
//   node --env-file=.env.local scripts/upload-explore-media.mjs 01-aerial-view.jpg=C:\path\photo.jpg ...
//
// Names must match EXPLORE_MEDIA_FILES in src/lib/resort/explore-media.ts.
// Re-uploading a name replaces that file. Uses the service-role key server-side only.
import { readFileSync, statSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const FOLDER = 'resort-explore'
const LIMITS = { jpg: ['image/jpeg', 5], jpeg: ['image/jpeg', 5], png: ['image/png', 5], mp4: ['video/mp4', 16] }

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (use --env-file=.env.local).')
  process.exit(1)
}
const pairs = process.argv.slice(2).map((a) => {
  const i = a.indexOf('=')
  if (i < 1) throw new Error(`Expected name=path, got "${a}"`)
  return [a.slice(0, i), a.slice(i + 1)]
})
if (pairs.length === 0) {
  console.error('Nothing to upload.')
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })
let failed = 0
for (const [name, path] of pairs) {
  const ext = name.split('.').pop().toLowerCase()
  const limit = LIMITS[ext]
  if (!limit) throw new Error(`Unsupported file type: ${name}`)
  const [contentType, maxMb] = limit
  const size = statSync(path).size
  if (size > maxMb * 1024 * 1024) {
    console.error(`✗ ${name}: ${(size / 1048576).toFixed(1)} MB is over WhatsApp's ${maxMb} MB limit`)
    failed++
    continue
  }
  const { error } = await db.storage.from('flow-media').upload(`${FOLDER}/${name}`, readFileSync(path), {
    contentType,
    upsert: true,
    cacheControl: '86400',
  })
  if (error) {
    console.error(`✗ ${name}: ${error.message}`)
    failed++
  } else {
    console.log(`✓ ${name} (${(size / 1048576).toFixed(2)} MB) → ${db.storage.from('flow-media').getPublicUrl(`${FOLDER}/${name}`).data.publicUrl}`)
  }
}
process.exit(failed ? 1 : 0)
