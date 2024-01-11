# AESOP Afghanistan

Various scripts used to arrange phone buddies and manage the organization.

# To prospective employers

Hi! This repo leaves much to be desired in terms of code quality.
I have a list of todos that I'll leave here for what I'd change,
but suffice to say that much of the time,
my volunteer effort is better spent on other things.  

## What I would change

- Refactoring to allow for easier comprehension and modifications to the system
  - Adding comments to functions and classes 
- Adding unit tests
- Moving to a more robust system than an EC2 box and Cron

# Scripts

## Email phone buddies script

This script emails phone buddy pairs information about each other to allow them to connect.

Every 24 hours at midnight or 1 am (depending on daylight savings), the following script runs:
```
python3.10 email_phone_buddies.py --send-emails --robot
```

More info on how this works in practice (in human-digestible terms) is on
[Discord (linked)](https://discord.com/channels/1086570523267440790/1095031520101671005/1151396841670328340)
(You need to be on the Discord in order to see the link)

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

### Use

If the `tmux` session is not set up as you're used to, check out this cheat sheet: https://tmuxcheatsheet.com/

Example of use:
```
laptop$ IP=0.0.0.0 #get this from Teo prior to executing these steps (look on Discord)
laptop$ ssh -i /path/to/phone_buddy_key_pair.pem ec2-user@$IP
server$ tmux a          # attach to running tmux session
server$ cd ~/aesop-afghanistan/
server$ rm token.json   # if the token file has expired
server$ python3.10 email_phone_buddies.py  # to validate the emails look good
Please visit this URL to authorize this application: https://accounts.google.com/o/oauth2/...

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
chmod 700 /path/to/phone_buddy_key_pair.pem
```
