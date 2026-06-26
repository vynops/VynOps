import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { Providers } from '@/components/providers'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: { default: 'VynOps AI', template: '%s | VynOps AI' },
  description: 'AI-Native Cloud Operations Platform — Enterprise AIOps for Kubernetes, Cloud & Infrastructure',
  keywords: ['AIOps', 'Kubernetes', 'Observability', 'AI Operations', 'SRE', 'DevOps'],
}

export const viewport: Viewport = {
  themeColor: '#020617',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} dark`} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
