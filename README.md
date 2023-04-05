# AESOP Afghanistan

Various scripts used to arrange phone buddies and manage the organization

## Scripts

### Email phone buddies

This script emails phone buddy pairs information about each other to allow them to connect.

#### Installation

TODO: not done quite yet
1. Follow [quickstart guide here](https://developers.google.com/gmail/api/quickstart/python)

#### Using
1. `gcloud auth application-default login`

Example of use:
```
$ python3 email_phone_buddies.py
You are about to send 23 emails to phone buddy volunteers. Are you sure you want to continue? [y/N]: y
Okay... well let's just make you wait for a few seconds (5) and see if you change your mind.
Are you still absolutely, positively sure? [y/N]: y
Hmm, you seem quite sure of yourself, but let's wait another 5 seconds just in case.
Last chance to cancel! Still sure? [y/N]: y
Ugh, fine, we'll send the emails.

Will wait 1 seconds between each email.
Sending email to Zahra (Zahra) - zahra@aesopafghanistan.org and Teo Fleming (Teo) - mokolodi1@gmail.com
Message sent: {'id': '1875330a9539d62d', 'threadId': '1875330a9539d62d', 'labelIds': ['UNREAD', 'SENT', 'INBOX']}
...
```