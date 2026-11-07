import type { ExploreContent } from './bot/types'

export const EXPLORE_WEBSITE_URL = 'https://vfarms.in/'

/** Public folder in the `flow-media` Storage bucket; files are uploaded by scripts/upload-explore-media.mjs. */
export const EXPLORE_MEDIA_FOLDER = 'resort-explore'

/** Sent in this order. Images ≤ 5 MB (JPEG/PNG), video ≤ 16 MB (MP4) — WhatsApp limits. */
export const EXPLORE_MEDIA_FILES: { file: string; kind: 'image' | 'video'; caption?: string }[] = [
  { file: '01-aerial-view.jpg', kind: 'image', caption: 'V-Farms from above' },
  { file: '02-estate-morning.jpg', kind: 'image', caption: 'The private estate' },
  { file: '03-cottage.jpg', kind: 'image', caption: 'The cottage' },
  { file: '04-dining-hall.jpg', kind: 'image', caption: 'Lounge & dining hall' },
  { file: '05-pool.jpg', kind: 'image', caption: 'Private swimming pool' },
  { file: '06-bonfire.jpg', kind: 'image', caption: 'Evening bonfire' },
  { file: '07-night-view.jpg', kind: 'image', caption: 'V-Farms at night' },
  { file: '08-dragon-fruit-farm.jpg', kind: 'image', caption: 'Our dragon fruit farm' },
  { file: '09-farm-tour.mp4', kind: 'video', caption: '🎥 A quick tour of V-Farms' },
]

export function exploreMediaUrl(supabaseUrl: string, file: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/flow-media/${EXPLORE_MEDIA_FOLDER}/${file}`
}

export function exploreContent(supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL): ExploreContent {
  return {
    website: EXPLORE_WEBSITE_URL,
    media: supabaseUrl?.startsWith('https://')
      ? EXPLORE_MEDIA_FILES.map((m) => ({ kind: m.kind, url: exploreMediaUrl(supabaseUrl, m.file), ...(m.caption ? { caption: m.caption } : {}) }))
      : [],
  }
}
