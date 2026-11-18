window.NB = window.NB || {};
NB.checklist = {
  "done": ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "x2", "x3", "x4", "t1", "c16", "t2", "t3", "t4", "c10", "c1", "c2", "c4", "c5", "c7", "c8", "x5", "c3", "c13", "c14", "d1", "x1", "d2", "d3", "d4", "d5", "d6", "d7", "q1", "q2", "q3", "q4", "q5", "q6", "c6", "c9", "c11", "v4", "c12", "c15", "v1", "v2", "v3", "v5", "v6", "v7"],
  "groups": [
    ["Setup", [
      ["s1", "I can log in to the HappyRobot platform"],
      ["s2", "Claude is connected to HappyRobot (workflows and Twin)"],
      ["s3", "TMS host, port and token are saved in .env"],
      ["s4", "FMCSA key is saved in .env"],
      ["s5", "Private GitHub repo is created"],
      ["s6", "Google Cloud project with billing and a budget alert"],
      ["s7", "Twin database and gateway are set up"]
    ]],
    ["The call", [
      ["c1", "The call starts from a web call link, no phone number"],
      ["c2", "The agent asks for the MC number and checks it with FMCSA"],
      ["c3", "A carrier without active authority is politely ended"],
      ["c4", "After FMCSA passes, a code is sent by SMS or email"],
      ["c5", "No load is mentioned until the carrier reads the code back correctly"],
      ["c15", "The code only ever goes to a contact on file (broker records, then FMCSA); no contact means a polite end"],
      ["c16", "Load search refuses to run until the code is verified, even if the agent is talked around"],
      ["c6", "No story gets the carrier past the code (“my phone died”, “I’m the owner”)"],
      ["c7", "The agent finds real loads from the TMS that match lane and equipment"],
      ["c8", "The agent pitches the load clearly: lane, dates, equipment, rate"],
      ["c9", "The agent never reveals the max rate, even when asked sideways"],
      ["c10", "The agent never agrees to a price above the max rate"],
      ["c11", "After 3 counter-offers with no deal: polite close, logged as failed, no transfer"],
      ["c12", "When a price is agreed, the load is reserved; a senior rep confirms the booking in the TMS (D-025)"],
      ["c13", "The carrier is handed to a senior rep (mocked transfer)"],
      ["c14", "The agent sounds short, direct and friendly"]
    ]],
    ["TMS connection", [
      ["t1", "Connects over the TCP socket using the fixed-width format"],
      ["t2", "Search, load details and booking all work"],
      ["t3", "When the TMS times out or sends garbage, the agent handles it calmly"],
      ["t4", "I can show a TMS failure during the demo"]
    ]],
    ["Data and dashboard", [
      ["d1", "Every call is saved in Twin: MC, load, rate, outcome, notes"],
      ["d2", "If anything lives outside Twin, the reason is written down"],
      ["d3", "Ops dashboard is built in HappyRobot Apps"],
      ["d4", "The dashboard shows real call data, no placeholders"],
      ["d5", "The ops manager can take action from it, not only look"],
      ["d6", "The dashboard loads clean after a fresh reload"],
      ["d7", "If anything is outside HappyRobot Apps, the reason is written down"]
    ]],
    ["Security and deploy", [
      ["x1", "Every endpoint requires authentication (OAuth2 token)"],
      ["x2", "No secrets are in the repo"],
      ["x3", "Everything runs in Docker"],
      ["x4", "One command deploys it to the cloud"],
      ["x5", "The deployed URL works from outside my laptop"]
    ]],
    ["Testing", [
      ["q1", "Northstar KPIs are defined (booking rate, margin kept, time to verify)"],
      ["q2", "Scripted tests for normal calls"],
      ["q3", "Scripted tests for edge cases (no loads, bad MC, TMS down)"],
      ["q4", "Adversarial tests: trying to get the max rate"],
      ["q5", "Adversarial tests: trying to skip the code"],
      ["q6", "Results are written down with pass or fail"]
    ]],
    ["Deliverables", [
      ["v1", "Email to HappyRobot Logistics that ties to their 5 problems and ends with a next step"],
      ["v2", "Build document that IT and business can both follow"],
      ["v3", "Repo link: private, ready to invite reviewers"],
      ["v4", "HappyRobot workflow link opens the live workflow"],
      ["v5", "About 5 minute video: live call, dashboard, QA results"],
      ["v6", "Video is rehearsed and doesn’t run long"],
      ["v7", "Every link clicked once right before submitting"]
    ]]
  ]
};
