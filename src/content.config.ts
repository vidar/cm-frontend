import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Edited through Sveltia CMS (/admin). Field names here must match
// public/admin/config.yml.

const home = defineCollection({
  loader: glob({ pattern: 'home.md', base: './src/content' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    heading: z.string(),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    showInMenu: z.boolean().default(true),
    menuOrder: z.number().default(10),
  }),
});

export const collections = { home, pages };
