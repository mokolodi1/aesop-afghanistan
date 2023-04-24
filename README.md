# AESOP Afghanistan

Various scripts used to arrange phone buddies and manage the organization

# Scripts

## Email phone buddies

This script emails phone buddy pairs information about each other to allow them to connect.

### Installation

1. Install Python
   1. 
      You should get to a point where you can write this on the terminal and it says you're using version 3.something.
      ```
      $ python3 --version
      ```
2. Install dependencies (TODO)
   1. Maybe: follow [quickstart guide here](https://developers.google.com/gmail/api/quickstart/python)
3. Log into the AESOP Google account
3. Clone the repo (either using `git clone` or downloading the zip file)
   1. Either:`git clone https://github.com/mokolodi1/aesop-afghanistan`
   2. Or: go [here](https://github.com/mokolodi1/aesop-afghanistan) and click `Code` => `Download ZIP`
4. Get secret files from Teo (he'll send them via Discord/WhatsApp)


### Using
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