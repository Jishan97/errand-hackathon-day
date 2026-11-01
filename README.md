# Errand — Hackathon Day

Errand is a phone-based assistant that carries out approved work between calls and calls back with a verified result.

Built for the [DevDay Exchange London Community Hackathon](https://luma.com/dde-ldn-hack) on Sunday, 1 November 2026.

## Current status

Planning only. The core user journey and implementation plan are being refined. No application implementation has started in this repository.

The initial commit contains this README and a `.gitignore`. There is no application to install, run or deploy yet. Setup instructions and a demo link will be added when a working build exists.

## Repository scope

This is the standalone public source repository for the `hackathon-day/` application, with `main` as its initial branch. Preparation code and learning records remain in the parent Errand workspace. The existing controlled Errand demo repository remains a separate integration target.

Reuse the existing OpenAI, GitHub, Vercel, Supabase, Twilio and other service setup as needed, including the existing GitHub App. Creating this source repository does not create or reconfigure any service or deployment.

## Existing work and credits

Errand's concept exploration, integration experiments and preparation work predate the hackathon build. That preparation is not included in this initial commit. Any code, templates or assets reused in the application will be credited here, with the work completed during the event identified separately.

## Configuration privacy

Credentials and personal data are excluded from this repository. Private dotenv files remain owner-managed and must not be inspected, copied or committed by agents. In the parent Errand workspace, proposed configuration changes belong only in the sanitized `mvp/.env.example` template, with private fields empty.
