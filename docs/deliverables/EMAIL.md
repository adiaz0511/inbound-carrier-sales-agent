**To:** HappyRobot Logistics, carrier sales and operations leadership
**Subject:** Measuring the return on your inbound carrier calls: proposed pilot

Hello team,

Every inbound carrier call that goes unanswered at peak hours is a load that may go to another broker, and every rate negotiated differently from the last one gives away margin. Manual FMCSA checks and the lack of a call record add rep time to each of those calls. These five areas of opportunity are where an AI agent can return value quickly.

An AI agent built on HappyRobot now handles the first part of each inbound carrier call, and it is running in a production environment:

1. **Every call is answered.** Kate, the voice agent, answers immediately at any hour, including the Monday morning rush, so carriers do not wait or hang up.
2. **Every rate follows the same rules.** Each load is negotiated with up to 3 counter-offers and never above the maximum rate in the TMS. The agent never receives that maximum, so it cannot disclose it.
3. **Carriers are verified automatically.** The agent checks operating authority with FMCSA and sends a one-time code to the contact on file before any load is discussed.
4. **Every call is on record.** Each call, code check, offer and outcome is saved in Twin, with a link to the recording, so a disputed rate becomes a lookup.
5. **Reps only handle agreed deals.** A representative steps in only after a carrier accepts a rate, reviews the deal in the Carrier Ops dashboard and confirms the booking in the TMS.

The agent never books a load by itself: it places a 60-minute hold, and a representative confirms the booking. It works with the current TMS and recovers from its timeouts and invalid replies. In testing, the service passed 312 of 312 automated tests, and attack tests produced zero rate disclosures and zero verification bypasses.

The return can already be measured. In live calls, carriers were verified in under a minute without a dispatcher. In a small scripted test set, the agent kept 27% of the room between the posted rate and the maximum, and the dashboard reports the margin kept on every deal. The attached build document explains how each of these numbers is calculated.

The proposed next step is a 2-week pilot on one live phone line during peak hours, designed to prove that return with your own traffic. The pilot would track answer rate, time to verify, reservation rate, margin kept and rep time per booking, and compare them with your current baseline. SMS codes would be enabled, and the handoff would connect to the senior-representative line. Could we meet for 30 minutes next week to choose the line and lanes, and to agree on the baseline figures for the comparison?

Best,
Arturo Díaz

Links:
- Live workflow (web call): https://platform.happyrobot.ai/deployments/gzojj9w9w21e
- Carrier Ops dashboard: https://hr-carrier-ops.happyrobot.dev
- Build document: https://claude.ai/artifact/8ss4Y5GmLBNuawUDVSgUP9
- Repository: https://github.com/adiaz0511/inbound-carrier-sales-agent
