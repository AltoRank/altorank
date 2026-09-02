# Auth email templates

Branded versions of the emails Supabase Auth sends on our behalf. They mirror
`lib/email/layout.ts` by hand, because Supabase templates cannot import code.

Hosted project (the one that matters): paste each file into
**Authentication → Email Templates** in the Supabase dashboard, with these
subjects:

| Template | Subject |
|---|---|
| Confirm signup | Confirm your AltoRank account |
| Reset password | Reset your AltoRank password |
| Magic link | Your AltoRank sign-in link |
| Change email address | Confirm your new email for AltoRank |
| Invite user | You have been invited to AltoRank |

Then under **Authentication → SMTP Settings** enable custom SMTP with Resend:
host `smtp.resend.com`, port `465`, user `resend`, password = the Resend API
key, sender `AltoRank <noreply@updates.altorank.co>` (the verified domain).
Set **Site URL** to `https://app.altorank.co` and add
`https://app.altorank.co/**` to the redirect allow-list, or every link in
these emails lands on the wrong host.

Local (`supabase start`): `config.toml` points at these files, so the same
markup shows up in Inbucket.
