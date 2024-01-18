from functools import cache
import os.path
from urllib.parse import parse_qs, urlparse

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build


# NOTE: When modifying these scopes, delete the file token.json.
SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    "https://www.googleapis.com/auth/spreadsheets"
]


AUTH_INSTRUCTIONS = """Please go to the following URL and finish the authentication process. \
After you complete the process, you will be forwarded to a URL that will appear to be broken - this is normal. \
You will copy and paste that URL here in order to complete the authentication process."""


class GoogleServiceProvider:
    @staticmethod
    @cache
    def __get_credentials():
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
                flow = InstalledAppFlow.from_client_secrets_file(
                    'secrets/credentials.json', SCOPES)

                # Use a local server for the redirect_uri
                redirect_url = 'http://localhost:8080/'
                flow.redirect_uri = redirect_url

                auth_url, _ = flow.authorization_url(prompt='consent')

                print(AUTH_INSTRUCTIONS)
                print()
                print(auth_url)
                print()
                url = input("Enter the URL you are forwarded to (which appears broken and starts with %s): " % redirect_url)

                # Extract the authorization code from the URL
                parsed_url = urlparse(url)
                query_params = parse_qs(parsed_url.query)
                auth_code = query_params.get("code", [None])[0]

                # TODO: ask again if they sent in something that doesn't make sense 
                # (add a while loop that allows them to try a few times)
                # (https://github.com/mokolodi1/aesop-afghanistan/issues/22)

                flow.fetch_token(code=auth_code)
                creds = flow.credentials
        else:
            # always try to refresh the credentials - might as well try!
            creds.refresh(Request())

        # Save the credentials for the next run (regardless of whether they've been updated)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

        print("creds at the end: %s", creds)
        return creds

    @staticmethod
    def sheets_service():
        return build('sheets', 'v4', credentials=GoogleServiceProvider.__get_credentials())

    @staticmethod
    def gmail_service():
        return build('gmail', 'v1', credentials=GoogleServiceProvider.__get_credentials())