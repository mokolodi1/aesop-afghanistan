# AESOP Afghanistan

This repo contains various scripts used to arrange phone buddies and manage the organization.

[For more information about AESOP Afghanistan and the phone buddy script specifically, please refer to our website (linked).](https://aesopafghanistan.org/about)

# To prospective employers of Teo (and others!)

Hi! This project is under active development. We are currently working on fixing bugs and refactoring to allow for future development.

Our long-term goal (within the next 6 months to a year) is to have a system that can be administered by a group of Afghan volunteers instead of Seth and Teo.

## Future projects

- Fixing bugs (see project issues for specifics)
- Adding integration and unit tests
- Moving to a more robust deployment than an EC2 box with Cron (not pretty, but it's worked for over 6 months with zero issues)

# Scripts

## Email phone buddies script

This script emails phone buddy pairs information about each other to allow them to connect.

### What the phone buddy script does

Every 24 hours at midnight or 1 am California/Pacific Time (depending on daylight savings), the following script runs:
```
python email_phone_buddies.py --send-emails --robot
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
IP=0.0.0.0 # get this from Teo prior to executing these steps (look on Discord)
scp -r -i /path/to/phone_buddy_key_pair.pem /path/to/secrets ec2-user@$IP:/home/ec2-user/aesop-afghanistan
ssh -i /path/to/phone_buddy_key_pair.pem ec2-user@$IP

# On server - install updates, tools, and download code
sudo yum update -y && sudo yum install git tmux docker emacs-nox cronie -y
tmux
sudo systemctl enable crond
sudo systemctl start crond
sudo systemctl start docker
sudo usermod -aG docker ec2-user

# Reconnect to the server to allow the changes to take affect

# Install code and Teo's dotfiles
cd ~
git clone https://github.com/mokolodi1/aesop-afghanistan
git clone https://github.com/mokolodi1/dotfiles
cd dotfiles
./install.sh

# Note: might want to restart tmux in order to pull latest configuration file
```

#### Set up Cron

Set up `cron` as follows with `crontab -e`:

```
0 9 * * * { echo "[$(date +\%Y-\%m-\%d\ \%H:\%M:\%S)] Starting job"; /usr/bin/docker run -it --rm -v /home/ec2-user/aesop-afghanistan:/app aesop-phone-buddy-script python phonebuddies/email_phone_buddies.py --send-emails --robot; echo "[$(date +\%Y-\%m-\%d\ \%H:\%M:\%S)] Job completed"; } >> /home/ec2-user/aesop-afghanistan/cron_logs.txt 2>&1
```

### Manual use - production

If the `tmux` session is not set up as you're used to, check out this cheat sheet: https://tmuxcheatsheet.com/

Example of use:
```
laptop$ IP=0.0.0.0                         # get this and the .pem file from Teo prior to executing these steps
laptop$ ssh -i /path/to/phone_buddy_key_pair.pem ec2-user@$IP
server$ tmux a                             # attach to running tmux session
server$ cd ~/aesop-afghanistan/
server$ rm token.json                      # if the token file has expired
server$ /usr/bin/docker run -it --rm -v /home/ec2-user/aesop-afghanistan:/app aesop-phone-buddy-script
```

If you get a scary-looking file permissions error, run the following:
```
chmod 400 /path/to/phone_buddy_key_pair.pem
```

# Contributing

As of January 2024, we're having weekly meetings to check in on development and move this project along. If you're interested in helping out, send Teo a WhatsApp at +33 6 17 50 71 28.

## How to set up your local device for development work

### 0. Get access to the spreadsheet

Teo will add you to the spreadsheet and appropriate documents. Bug him if he doesn't reach out and let you know where to look!

### 1. Clone this git repo locally
```
git clone https://github.com/mokolodi1/aesop-afghanistan
cd aesop-afghanistan
```

### 2. Install Docker

Ensure that Docker is installed on your local machine. If you don't have Docker installed, you can follow the installation instructions for your specific operating system on the official Docker website: [Docker Installation Guide](https://docs.docker.com/get-docker/).


You can get yourself into an environment where you can test the script using the following commands. 
```sh
docker build -t aesop-phone-buddy-script . && docker run -it --rm -v "$(pwd)":/app aesop-phone-buddy-script
```

You will be dropped into a Docker shell session where you can run commands in Python on the code that's on your filesystem.

### 3. Set up secrets locally

You'll need to set up several files locally in order to successfully run the script. Ask another team member to provide these files for you.

In the `secrets` folder, you'll need:
- `credentials.json`: Google Auth credentials file (can be downloaded from Teo's Google account [here](https://console.cloud.google.com/apis/credentials?project=aesop-afghanistan)).
- `admin_emails.txt`: A list of emails to be notified of issues/errors by the script. (Looks like: `email1@example.com,email2@example.com`)
- `spreadsheet_id.txt`: Contains the Google Sheets document ID. (Looks like `1LM8lzRMn9L5uwTWyes6tGfYiIiBFUxWIzQDFrbceDTA`.)

### 4. Run the test suite

This can be run in interactive mode in Docker to discover all the tests and run them:

```
python -m unittest discover
```

Run a specific test like this:

```
python -m unittest test.phonebuddies.test_PhoneBuddyManager.TestPhoneBuddyManager.test_manage_phone_buddy_list_send_admin_trial_emails
```

### 5. Manual testing

Some examples of what you can run when running in intefactive mode in Docker:
```
# Test the script without sending any emails
python phonebuddies/email_phone_buddies.py

# Test the script without the user prompts (this is how it will run on the server)
python phonebuddies/email_phone_buddies.py --robot

# Actually send emails (use with caution!)
python phonebuddies/email_phone_buddies.py --send-emails
```

### 6. Create a new branch 

You can create a new branch for your contributions. For example:

```bash
git checkout -b feature/new-feature
```

### 7. Make Changes

Make the necessary changes to the codebase, documentation, or other project files.

### 8. Commit Changes

```bash
git commit -m "Your commit message here."
```

### 9. Push Changes

You can push your branch to your forked repository on GitHub:

```bash
git push origin feature/new-feature
```

### 10. Submit a Pull Request

After making changes and ensuring that the tests pass, open a pull request from your branch to the main repository's `main`  branch. You can provide the description of your changes and reference any related issues or pull requests.