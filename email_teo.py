from __future__ import print_function

import base64
import os.path

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

    # encoded message
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