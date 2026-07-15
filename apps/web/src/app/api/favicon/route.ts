import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET() {
  const file = path.join(process.cwd(), 'src', 'app', 'icon.png')
  const buf = fs.readFileSync(file)
  return new NextResponse(buf, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  })
}
