import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import Script from 'next/script'
import './globals.css'
import { Providers } from '@/components/providers'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: { default: 'VynOps · VynOps Suite', template: '%s | VynOps' },
  description: 'AI-Native Cloud Operations Platform — Enterprise AIOps for Kubernetes, Cloud & Infrastructure',
  keywords: ['AIOps', 'Kubernetes', 'Observability', 'AI Operations', 'SRE', 'DevOps'],
  icons: { icon: '/api/favicon', shortcut: '/api/favicon', apple: '/api/favicon' },
}

export const viewport: Viewport = {
  themeColor: '#020617',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const preinitScript = `(function(){
  try{
    var V=['15m','30m','1h','3h','6h','12h','24h','7d','30d'];
    var tr=localStorage.getItem('timeRange');
    if(tr&&V.indexOf(tr)!==-1)window.__VYNOPS_TR=tr;
    var rt=localStorage.getItem('realtimeActive');
    if(rt!==null)window.__VYNOPS_RT=rt==='true';
  }catch(e){}
})();`
  return (
    <html lang="en" className={`${inter.variable} dark`} suppressHydrationWarning>
      <body className="font-sans antialiased">
        {/* Runs before ANY other script — guarantees localStorage is read before
            the Zustand store module evaluates on the client. */}
        <Script id="vynops-preinit" strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: preinitScript }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
