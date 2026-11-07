// Paths of the app's pages that are linked to from outside the app too: AI apps get links into Paperwork
// (server/mcp.ts). The app's own routing is in src/lib/router.ts.

// A company's (or topic's) name in its page's path. The server answers paths that look like file names ("Dr. Weber",
// "example.com") with a 404 instead of the app, and browsers turn an encoded dot (%2E) back into a dot, so dots
// (and percent signs, to tell them apart) are encoded twice: "Dr. Weber" is /companies/Dr%252E%20Weber.
export const encodeName = (name: string) => encodeURIComponent(name.replace(/%/g, '%25').replace(/\./g, '%2E'));

export const companyPagePath = (name: string) => `/companies/${encodeName(name)}`;

export const topicPagePath = (name: string) => `/topics/${encodeName(name)}`;

// A document, open over the library
export const documentPath = (id: string) => `/?doc=${encodeURIComponent(id)}`;
