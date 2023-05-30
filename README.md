# AESOP Afghanistan

Various scripts used to arrange phone buddies and manage the organization.

# Scripts

## Email phone buddies script

This script emails phone buddy pairs information about each other to allow them to connect.

### Installation

The following steps are used to set up a fresh EC2 server.

```
# On laptop - move over PEM file and secrets folder and ssh into server
IP=0.0.0.0 #get this from Teo prior to executing these steps (look on Discord)
scp -r -i /path/to/phone_buddy_key_pair.pem /path/to/secrets ec2-user@$IP:/home/ec2-user/aesop-afghanistan
ssh -i /path/to/phone_buddy_key_pair.pem ec2-user@$IP

# On server - install updates, tools, and download code
sudo yum update -y && sudo yum install git tmux python3-pip emacs-nox -y
tmux
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