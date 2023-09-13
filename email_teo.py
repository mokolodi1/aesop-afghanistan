from __future__ import print_function

import base64
import os.path
import sys
import time

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from email.message import EmailMessage

from twilio.rest import Client


# NOTE: When modifying these scopes, delete the file token.json.
SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    "https://www.googleapis.com/auth/spreadsheets"
]


TWILIO_ACCOUNT_SID = "ACf5ecfbf9e3a6ddc33ea046091ffed50a"
TWILIO_AUTH_TOKEN = None
with open("secrets/twilio_auth_token.txt", mode="r") as twilio_auth_token_file:
    TWILIO_AUTH_TOKEN = twilio_auth_token_file.read()
twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)


TWILIO_PHONE_NUMBER = None
with open("secrets/twilio_phone_number.txt", mode="r") as twilio_phone_number_file:
    TWILIO_PHONE_NUMBER = twilio_phone_number_file.read()


TEO_PHONE_NUMBER = None
with open("secrets/teo_phone_number.txt", mode="r") as teo_phone_number_file:
    TEO_PHONE_NUMBER = teo_phone_number_file.read()


# Time configuration
TWILIO_POLLING_INTERVAL = 2  # Time in seconds between each check
TWILIO_WAIT_DURATION = 30  # Total time in seconds to check the message status


def send_message_wait_for_sent(body):
    original_message = twilio_client.messages.create(
        body=body,
        from_=TWILIO_PHONE_NUMBER,
        to=TEO_PHONE_NUMBER
    )

    start_time = time.time()

    # Loop to check the status
    while time.time() - start_time < TWILIO_WAIT_DURATION:
        message = twilio_client.messages.get(original_message.sid).fetch()
        print("Checking message status...");
        print(f"  Status: {message.status}")
        print(f"  Body: {message.body}")
        print(f"  Date Sent: {message.date_sent}")
        print(f"  Date Updated: {message.date_updated}")
        print(f"  From: {message.from_}")
        print(f"  To: {message.to}")
        print(f"  Price: {message.price}")
        print(f"  API Version: {message.api_version}")
        print(f"  Error Message: {message.error_message}")
        print(f"  Error Code: {message.error_code}")

        if message.status != "sending":
            print("Message left sending status - not checking status anymore")
            break

        # Wait for the next polling cycle
        time.sleep(TWILIO_POLLING_INTERVAL)


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
            try:
                creds.refresh(Request())
            except RefreshError as e:
                print("Auth error with Google - alerting Teo")
                send_message_wait_for_sent("Hello, this is a message from Twilio!")
                sys.exit(1)
        else:
            flow = InstalledAppFlow.from_client_secrets_file('secrets/credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    return creds


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
    message['From'] = 'contact@aesopafghanistan.org'
    message['Subject'] = subject

    encoded_message = base64.urlsafe_b64encode(message.as_bytes()).decode()

    create_message = {
        'raw': encoded_message
    }
    send_message = gmail_service.users().messages().send(userId="me", body=create_message).execute()

    print("Message sent: %s" % send_message)


def main():
    creds = get_credentials()
    gmail_service = build('gmail', 'v1', credentials=creds)

    send_email(gmail_service, "mokolodi1@gmail.com", "Test email - AESOP", "This is a test email sent by a program!")


if __name__ == '__main__':
    main()
