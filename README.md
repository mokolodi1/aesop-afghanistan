# AESOP Afghanistan

This repo contains various scripts used to arrange phone buddies and manage the organization.

[For more information about AESOP Afghanistan and the phone buddy script specifically, please refer to our website (linked).](https://aesopafghanistan.org/about)

# To prospective employers of Teo (and others!)

Hi! This project is under active development. We are currently working on fixing bugs and refactoring to allow for future development.

Our long-term goal (within the next 6 months to a year) is to have a system that can be administered by a group of Afghan volunteers instead of Seth and Teo.

## Future projects

- Fixing bugs (see project issues for specifics)
- Refactoring to allow for easier comprehension and modifications to the system
  - Adding comments to functions and classes to make it clearer for very junior engineers
- Adding integration and unit tests
- Moving to a more robust deployment than an EC2 box with Cron (not pretty, but it's worked for over 6 months with zero issues)

# Scripts

## Email phone buddies script

This script emails phone buddy pairs information about each other to allow them to connect.

### What the phone buddy script does

Every 24 hours at midnight or 1 am California/Pacific Time (depending on daylight savings), the following script runs:
```
python3.10 email_phone_buddies.py --send-emails --robot
```

Coming soon: we'd like to run the script every 30 minutes instead of every 24 hours in order for it to report whether there would be any issues (like data being incorrectly filled out, etc.)

It does the following:
1. Coming soon: validates the database and that the list of buddies looks good. If there are any issues, report those to the admins if it's been more than 30 minutes since the issue occurred.
1. Checks whether there's a date in the Process sheet that meets the following criteria:
    1. Has a date that's in the past (assumes it's sorted)
    1. Has all the prerequisite rows filled out with `y` or `yes` (case insensitive)
1. Checks whether it should send to the admin group or real email list depending on whether the beta column has a `y` or `yes` (case insensitive)
1. Sends the phone buddy list to the appropriate list (admins or phone buddies)
1. Saves the output
    1. Fills in the corresponding cell in the Process sheet with an update on the outcome (Yes or Error). This means that Seth (or anyone else) can easily see if something went wrong with the script that Teo needs to check on or if the script didn't run at all.
    1. Coming soon: Writes a row to the `Script Output` sheet if it did anything (sent emails, validated things, etc.)

In practice, this means that the admin list (Seth, Teo, and others if we deem appropriate) will receive an email one day before the "real" email list is sent out, and it'll mark the Admin email sent column as Yes in the spreadsheet. We'll review this and make changes if there are any issues (spelling mistakes, etc.).

Given that the Process sheet has dates on Monday, the beta emails will be sent on Sunday night (technically early Monday morning), and the real emails on Monday night. It also means that if the prerequisite cells aren't filled out on the spreadsheet, it'll skip sending the emails for that night, and everything will be pushed to the next day (beta email will be sent first, then real email).

### Installation

The following steps are used to set up a fresh EC2 server.

```
# On laptop - move over PEM file and secrets folder and ssh into server
IP=0.0.0.0 #get this from Teo prior to executing these steps (look on Discord)
scp -r -i /path/to/phone_buddy_key_pair.pem /path/to/secrets ec2-user@$IP:/home/ec2-user/aesop-afghanistan
ssh -i /path/to/phone_buddy_key_pair.pem ec2-user@$IP

# On server - install updates, tools, and download code
sudo yum update -y && sudo yum install git tmux python3-pip emacs-nox cronie -y
tmux
sudo systemctl enable crond
sudo systemctl start crond

git clone https://github.com/mokolodi1/aesop-afghanistan

# On server - install Python 3.10
# Pulled from: https://devopsmania.com/how-to-install-python3-on-amazon-linux-2/
sudo yum update -y
sudo yum groupinstall "Development Tools" -y
sudo yum install openssl-devel libffi-devel bzip2-devel wget -y
cd /opt
sudo wget https://www.python.org/ftp/python/3.10.2/Python-3.10.2.tgz
sudo tar xzf Python-3.10.2.tgz
cd Python-3.10.2
sudo ./configure --enable-optimizations
make -j $(nproc)
sudo make altinstall

# On server - install Google dependencies
# (Following steps here: https://developers.google.com/gmail/api/quickstart/python)
pip3.10 install --upgrade google-api-python-client google-auth-httplib2 google-auth-oauthlib click

# On server - install Teo's dotfiles
cd ~
git clone https://github.com/mokolodi1/dotfiles
cd dotfiles
./install.sh
```

#### Set up Cron

Set up `cron` as follows with `crontab -e`:

```
0 9 * * * { echo "[$(date +\%Y-\%m-\%d\ \%H:\%M:\%S)] Starting job"; cd /home/ec2-user/aesop-afghanistan && /usr/local/bin/python3.10 /home/ec2-user/aesop-afghanistan/email_phone_buddies.py --send-emails --robot; echo "[$(date +\%Y-\%m-\%d\ \%H:\%M:\%S)] Job completed"; } >> /home/ec2-user/aesop-afghanistan/cron_logs.txt 2>&1
```

### Manual use

If the `tmux` session is not set up as you're used to, check out this cheat sheet: https://tmuxcheatsheet.com/

Example of use:
```
laptop$ IP=0.0.0.0                         # get this and the .pem file from Teo prior to executing these steps
laptop$ ssh -i /path/to/phone_buddy_key_pair.pem ec2-user@$IP
server$ tmux a                             # attach to running tmux session
server$ cd ~/aesop-afghanistan/
server$ rm token.json                      # if the token file has expired
server$ python3.10 email_phone_buddies.py  # to validate the emails look good
Please visit this URL to authorize this application: https://accounts.google.com/o/oauth2/...

# In a different window (could be via tmux or re-ssh-ing onto the host), run the command
# that you get after authorizing with the Google URL from above ^^
server2$ curl "http://localhost:60325/..."

server$ python3.10 email_phone_buddies.py --send-emails
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

If you get a scary-looking file permissions error, run the following:
```
chmod 400 /path/to/phone_buddy_key_pair.pem
```

# Contributing

As of January 2023, we're having weekly meetings to check in on development and move this project along. If you're interested in helping out, send Teo a WhatsApp at +33 6 17 50 71 28. 

## How to set up your local device for development work

### 0. Get access to the spreadsheet

TODO: write this (e.g. ask Teo to add you)

### 1. Clone this git repo locally
```
git clone https://github.com/mokolodi1/aesop-afghanistan
cd aesop-afghanistan
```

### 2. Install Docker

TODO: link to docker installation documentation online

### 3. Set up secrets locally

You'll need to set up several files locally in order to successfully run the script. Ask Teo for directions!

### 4. Run the test suite

TODO: can fill this in once we we have info on the test suite

### 5. Manual testing

You can get yourself into an environment where you can test the script using the following commands. 
```sh
docker build -t aesop-phone-buddy-script . && docker run -it --rm -v "$(pwd)":/app aesop-phone-buddy-script
```

You will be dropped into a Docker shell session where you can run commands that will execute the script, like so:
```
# Test the script without sending any emails
python email_phone_buddies.py

# Test the script without the user prompts (this is how it will run on the server)
python email_phone_buddies.py --robot

# Actually send emails (use with caution!)
python email_phone_buddies.py --send-emails
```