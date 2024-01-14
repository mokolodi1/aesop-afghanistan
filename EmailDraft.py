import itertools
from Buddy import Buddy

from DatabaseConnector import DatabaseConnector
from EmailInfo import EmailInfo


class EmailDraft:

    def __init__(self, to, subject, contents):
        # TODO: for development purposes, allow us to change the coming_from email via a file in secrets/
        # NOTE: likely break this into EmailDrafter and EmailDraft
        # (https://github.com/mokolodi1/aesop-afghanistan/issues/21)
        
        self.to = to
        self.coming_from = "contact@aesopafgahnistan.org"
        self.subject = subject
        self.contents = contents


    def __str__(self) -> str:
        return 'EmailDraft(to=%s; from=%s; subject="%s"; contents_length=%d)' % (self.to, self.coming_from, self.subject, len(self.contents))


    def draft_buddies_email(email_info: EmailInfo, first_buddy: Buddy, second_buddy: Buddy):
        to = [first_buddy.email, second_buddy.email]
        pseudonyms = (first_buddy.pseudonym, second_buddy.pseudonym)
        subject = "AESOP Phone buddy introduction: %s and %s" % pseudonyms

        name_and_name = "%s and %s" % pseudonyms
        email_text = f"""Hello {name_and_name},

{email_info.introduction}

{name_and_name}, you are AESOP phone buddies this week. Please find each of your contact information below.

{first_buddy.contact_text()}

{second_buddy.contact_text()}

You can update your buddy information by submitting this form, which will overwrite any previous info:
https://forms.gle/c8UZ6BXSxGmkw5GN7

{email_info.topic}

Best,

Your friendly AESOP Admin"""
        
        return EmailDraft(to, subject, email_text)


    def draft_overdue_process_admin_reminder(email):
        message = f"""Hi AESOP Phone Buddy Admin,

Don't forget to fill out the Process sheet for the AESOP phone buddies!

{DatabaseConnector.get_database_link}

Best,

Teo
"""

        return EmailDraft(email, "ACTION NEEDED: AESOP Phone Buddy Reminder", message)
