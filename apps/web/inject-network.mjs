import { readFileSync, writeFileSync } from 'fs'

const file = 'src/app/(dashboard)/infrastructure/page.tsx'
let src = readFileSync(file, 'utf8')

// Find the exact closing of the Cluster Network Summary section
// Look for: </table>\n            </div>\n          </div>\n        )}\n\n        {/* ... DATABASES
const marker = 'Cluster Network Summary'
const idx = src.indexOf(marker)
console.log('Marker at:', idx)

// Find the closing </div></div>} that ends the Network tab
// After the cluster network summary table close, we have:
//   </table>\n            </div>\n          </div>\n        )}\n\n        {/* DATABASES
const tablesEnd = src.indexOf('</table>\n            </div>\n          </div>\n        )}\n\n        {', idx)
console.log('Table end at:', tablesEnd)
if (tablesEnd === -1) {
  // Try with \r\n
  const tablesEndCR = src.indexOf('</table>\r\n            </div>\r\n          </div>\r\n        )}\r\n\r\n        {', idx)
  console.log('Table end (CRLF) at:', tablesEndCR)
}

// Show what's around that area
const lineAt = (src, pos) => src.slice(0, pos).split('\n').length
console.log('Context around marker:')
console.log(JSON.stringify(src.slice(idx-50, idx+300)))
