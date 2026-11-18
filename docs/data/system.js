window.NB = window.NB || {};
NB.system = {
  "updated": "2026-11-09",
  "status": "Draft. Boxes marked open change as their decisions close.",
  "diagrams": [
    {
      "id": "parts",
      "title": "The parts and how they talk",
      "caption": "Who talks to whom. Solid lines are decided; dotted lines depend on an open decision. The ceiling (MAX_BUY) enters our service from the TMS and never leaves it.",
      "mermaid": "flowchart LR\n  C([Carrier on a web call]) --> A[HappyRobot voice agent<br/>workflow]\n  A -- \"Webhook tools + auth (D-016)\" --> API[Our service<br/>TypeScript, Docker on Cloud Run]\n  API -- \"live call state and holds (D-017, D-025)\" --> FS[(Firestore<br/>short-lived state, holds)]\n  API --> F[FMCSA API<br/>carrier authority]\n  API --> T[TMS adapter module<br/>timeouts, retries, validation]\n  T -- \"TCP, one request per connection\" --> TMS[(Legacy TMS<br/>loads, MAX_BUY)]\n  API -- \"durable records\" --> TW\n  A -- \"send code to contact on file\" --> OTP[OTP delivery<br/>HappyRobot email<br/>SMS once a sender exists, D-023]\n  A -- \"log every call\" --> TW[(Twin<br/>call records)]\n  UI[HappyRobot App<br/>Carrier Ops dashboard] -- \"ops API, own OAuth client (D-027)\" --> API\n  API -- \"read-only SQL (D-026)\" --> TW\n  A -- \"mocked transfer\" --> R[Senior rep queue<br/>mocked]"
    },
    {
      "id": "call",
      "title": "One call, start to finish",
      "caption": "The order the brief requires. The code check sits between FMCSA and any load talk, and nothing skips it.",
      "mermaid": "flowchart TD\n  S([Web call starts]) --> MC[Ask for MC number]\n  MC --> FM{FMCSA: active<br/>authority?}\n  FM -- no --> E1([Polite end, log: not eligible])\n  FM -- yes --> WHO{Contact on file?<br/>broker records, then FMCSA census}\n  WHO -- none --> E0([Polite end, offer callback,<br/>flag: needs onboarding])\n  WHO -- found --> SEND[Send one-time code<br/>to that contact only]\n  SEND --> V{Code read back<br/>correctly?}\n  V -- \"no, attempts left\" --> V\n  V -- \"no, out of attempts\" --> E2([Polite end, log: not verified])\n  V -- yes --> L[Ask lane + equipment,<br/>search TMS]\n  L --> HAS{Matching load?}\n  HAS -- no --> E3([Polite end, log: no match])\n  HAS -- yes --> P[Pitch load at listed rate]\n  P --> N{Carrier accepts?}\n  N -- counter --> CK{Service checks counter<br/>against ceiling + round}\n  CK -- \"above ceiling, rounds left\" --> N\n  CK -- \"no deal after 3 rounds\" --> E4([Polite end, log: failed negotiation,<br/>no transfer])\n  CK -- \"within ceiling\" --> B\n  N -- yes --> B[Book load in TMS]\n  B --> H([Mocked transfer to senior rep,<br/>log: booked])"
    },
    {
      "id": "tms",
      "title": "One TMS request, and what happens when it breaks",
      "caption": "How the adapter survives the four injected faults (R-15). Searches and lookups retry; a booking is never resent blindly, it is checked instead (R-14).",
      "mermaid": "flowchart TD\n  O[Open a new TCP connection] --> W[Send one line:<br/>CMD + AUTH + fields]\n  W --> RD{Read until END or ERR,<br/>with our own timeout}\n  RD -- \"ERR line\" --> ER[Map error code<br/>to a clear result]\n  RD -- \"END reached\" --> CL[Close at once<br/>don't wait for server]\n  CL --> VAL{Every record valid?<br/>fields, widths, types}\n  VAL -- yes --> OK([Clean data back to the service])\n  VAL -- no --> BAD[Malformed]\n  RD -- \"timeout or closed before END\" --> BAD2[Timeout / partial]\n  BAD --> KIND{Which command?}\n  BAD2 --> KIND\n  KIND -- \"search or lookup\" --> RT{Attempts left?}\n  RT -- yes --> O\n  RT -- no --> FAIL([Tell the agent: system busy,<br/>offer a callback, log it])\n  KIND -- booking --> REC[LOAD_GET: is it booked<br/>on our token?]\n  REC -- \"BOOKED\" --> OK\n  REC -- \"still OPEN\" --> RB{Booking attempts left?}\n  RB -- yes --> O\n  RB -- no --> FAIL"
    }
  ],
  "parts": [
    { "name": "Carrier on a web call", "status": "decided", "ref": "D-011",
      "what": "The carrier starts the call from a web link in the browser. No phone number is provisioned. The production link is open to anyone; identity is proven by FMCSA plus the one-time code." },
    { "name": "HappyRobot voice agent (workflow)", "status": "decided", "ref": "Brief",
      "what": "Talks to the carrier, follows the call flow, and calls our service through Webhook tools. It holds the conversation; it never holds business rules or the rate ceiling." },
    { "name": "Our service", "status": "decided", "ref": "D-007",
      "what": "One TypeScript service in Docker on Google Cloud Run (D-015), built as modules: TMS adapter, FMCSA client, OTP, negotiation, booking. Every endpoint requires authentication (D-016), with rate limits and failed-auth logging in the service. Staging and production run the same image. It keeps no state in memory, so more copies can run when volume grows." },
    { "name": "TMS adapter module", "status": "decided", "ref": "D-006",
      "what": "Speaks the TMS's line protocol: a fresh connection per request, its own short timeout, stops reading at END, checks every record, retries searches and lookups, and checks bookings instead of resending them." },
    { "name": "Legacy TMS", "status": "decided", "ref": "Brief",
      "what": "The source of loads. LOAD_QUERY searches, LOAD_GET returns the full record including MAX_BUY (the ceiling), LOAD_BOOK books. It fails on purpose: timeouts, cut-off replies, garbled replies, connections left open." },
    { "name": "Live call state (Firestore)", "status": "decided", "ref": "D-017",
      "what": "Short-lived state while a call is in progress: hashed code, attempts, counter rounds, booking attempts, per-carrier caps. The service owns it and updates it atomically. Nothing here is a business record; every record lives in Twin." },
    { "name": "FMCSA API", "status": "decided", "ref": "Brief",
      "what": "The government lookup for whether a carrier's MC number has active operating authority. Called by our service." },
    { "name": "One-time code", "status": "decided", "ref": "D-008",
      "what": "Every call, after FMCSA passes. Sent only to a contact on file: the broker's carrier records first, then the contact registered with FMCSA; no contact means a polite end and an onboarding flag. Our service creates and checks the code; HappyRobot email delivers it (SMS once a sender exists, D-023); load search refuses to run until the call is verified." },
    { "name": "Negotiation rules", "status": "decided", "ref": "D-010",
      "what": "Our service judges every counter-offer against MAX_BUY and the round count. The model only hears accept, a counter price, or no deal." },
    { "name": "Twin", "status": "decided", "ref": "D-003",
      "what": "HappyRobot's own database. Every call is recorded here: MC, load, rates offered, outcome, notes. The brief requires it." },
    { "name": "HappyRobot Apps dashboard", "status": "decided", "ref": "D-004",
      "what": "The ops manager's screen, a Next.js app. Reads from Twin, shows the key numbers and lets them act, without opening raw platform logs." },
    { "name": "Senior rep queue", "status": "decided", "ref": "Brief",
      "what": "Where a booked carrier would be transferred. Web calls can't transfer (R-06), so this is mocked." }
  ]
};
