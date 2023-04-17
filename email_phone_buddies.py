from __future__ import print_function

import base64
import click
import os.path
import sys
import time
import argparse

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from email.message import EmailMessage


# NOTE: When modifying these scopes, delete the file token.json.
SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    "https://www.googleapis.com/auth/spreadsheets"
]

BETWEEN_EMAIL_PAUSE_SECS = 1

DATA_SPREADSHEET_ID = None
with open("secrets/spreadsheet_id.txt", mode="r") as spreadsheet_id_file:
    DATA_SPREADSHEET_ID = spreadsheet_id_file.read()


class Buddy:
    def __init__(self, row_info):
        self._raw_row_info = row_info

        self._parse_row_attribute("email", 0)
        self._parse_row_attribute("buddy_type", 1)
        self._parse_row_attribute("full_name", 2)
        self._parse_row_attribute("pseudonym", 3)
        self._parse_row_attribute("phone", 4, required=False)
        self._parse_row_attribute("location", 5, required=False)
        self._parse_row_attribute("time_zone", 6, required=False)
        self._parse_row_attribute("user_message", 7, required=False)

    def __str__(self):
        return "%s (%s) - %s" % (self.full_name, self.pseudonym, self.email)

    def _parse_row_attribute(self, attribute_name, row_index, required=True, default="None provided"):
        value = default
        data_provided = False
        if len(self._raw_row_info) >= row_index + 1:
            value = self._raw_row_info[row_index]

            if value != "":
                data_provided = True

        if required and not data_provided:
            print("ERROR: missing required %s data for buddy: %s" % (attribute_name, self._raw_row_info))
            sys.exit(1)

        setattr(self, attribute_name, value)

    def contact_text(self):
        return """Pseudonym: %s
Email: %s
Phone: %s
Location: %s
Time zone: %s
Introduction: %s""" % (self.pseudonym, self.email, self.phone, self.location, self.time_zone, self.user_message)


class EmailInfo():
    def __init__(self, drive_service):
        self._parse_email_info(drive_service)

    def _find_labeled_row_text(self, label_text):
        return next(row[1] for row in self._raw_rows if row[0] == label_text)

    def _parse_email_info(self, drive_service):
        result = drive_service.spreadsheets().values().get(
            spreadsheetId=DATA_SPREADSHEET_ID, range="'Email info'!A2:B500").execute()
        self._raw_rows = result.get('values', [])

        self.introduction = self._find_labeled_row_text("Intro")
        self.topic = self._find_labeled_row_text("Topic")


def get_credentials():
    creds = None

    # The file token.json stores the user's access and refresh tokens, and is
    # created automatically when the authorization flow completes for the first
    # time.
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)

    # If there are no (valid) credentials available, let the user log in.
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('secrets/credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    return creds

def get_buddy_email_pairs(drive_service):
    result = drive_service.spreadsheets().values().get(
        spreadsheetId=DATA_SPREADSHEET_ID, range="'Matched'!A2:B500").execute()
    rows = result.get('values', [])

    return rows

def get_buddies(drive_service):
    result = drive_service.spreadsheets().values().get(
        spreadsheetId=DATA_SPREADSHEET_ID, range="'Database'!A2:H500").execute()
    rows = result.get('values', [])

    return [Buddy(row) for row in rows]

def send_email(gmail_service, to, subject, email_text):
    """
    Based on code from Google:
    https://developers.google.com/gmail/api/guides/sending#python
    """
    message = EmailMessage()

    message.set_content(email_text)

    if isinstance(to, str):
        message['To'] = to
    else:
        message['To'] = ", ".join(to)
    message['From'] = 'teo@aesopafghanistan.org'
    message['Subject'] = subject

    # encoded message
    encoded_message = base64.urlsafe_b64encode(message.as_bytes()).decode()

    create_message = {
        'raw': encoded_message
    }
    send_message = gmail_service.users().messages().send(userId="me", body=create_message).execute()

    print("Message sent: %s" % send_message)

def create_buddy_email_map(buddies):
    buddy_email_map = {}

    for buddy in buddies:
        buddy_email_map[buddy.email] = buddy

    return buddy_email_map

def send_buddy_emails(gmail_service, drive_service, buddies, buddy_pairs, really_send_emails):
    buddy_email_map = create_buddy_email_map(buddies)
    if really_send_emails:
        print("Will wait %d seconds between each email." % BETWEEN_EMAIL_PAUSE_SECS)

    email_info = EmailInfo(drive_service)

    first_buddy_pair = True
    for buddy_pair in buddy_pairs:
        if really_send_emails:
            time.sleep(BETWEEN_EMAIL_PAUSE_SECS)

        first_buddy = buddy_email_map[buddy_pair[0]]
        second_buddy = buddy_email_map[buddy_pair[1]]

        pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
        name_and_name = "%s and %s" % pseudonyms
        subject = "Phone buddy introduction: %s and %s" % pseudonyms

        greeting = "Hello %s," % name_and_name
        phone_buddy_info = """%s, you are AESOP phone buddies this week. Please find each of your contact information below:

%s

%s
""" % (name_and_name, first_buddy.contact_text(), second_buddy.contact_text())
        email_text = """%s

%s

%s

%s

Best,

Your friendly AESOP Admin""" %\
                     (greeting, email_info.introduction, phone_buddy_info, email_info.topic)

        print("Prepping email to %s and %s" % (first_buddy, second_buddy))
        if first_buddy_pair:
            first_buddy_pair = False
            print("First buddy pair, so we'll print more info (subject, entire email text)")
            print("Subject: %s" % subject)
            print("Email text:")
            print("====================================")
            print(email_text)
            print("====================================")
            if really_send_emails:
                click.confirm("Does the above email look good to send to everyone?")
                print("Okay... well let's just make you wait for a few seconds (5) and see if you change your mind.")
                time.sleep(5)
                click.confirm('Are you still absolutely, positively sure?', abort=True, default=False)
                print("Hmm, you seem quite sure of yourself, but let's wait another 5 seconds just in case.")
                time.sleep(5)
                click.confirm('Last chance to cancel! Still sure?', abort=True, default=False)
                print("Okay, here we go!\n")

        if really_send_emails:
            send_email(gmail_service, buddy_pair, subject, email_text)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--send-emails", action='store_true')

    args = parser.parse_args()

    really_send_emails = args.send_emails

    creds = get_credentials()
    drive_service = build('sheets', 'v4', credentials=creds)
    gmail_service = build('gmail', 'v1', credentials=creds)

    buddy_pairs = get_buddy_email_pairs(drive_service)
    buddies = get_buddies(drive_service)

    if really_send_emails:
        click.confirm('You are about to send %s emails to phone buddy volunteers. Are you sure you want to continue?' % len(buddy_pairs), abort=True, default=False)
    else:
        print("--send-emails option not passed in, will calculate all emails to send but not actually send anything.")

    send_buddy_emails(gmail_service, drive_service, buddies, buddy_pairs, really_send_emails)

if __name__ == '__main__':
    main()